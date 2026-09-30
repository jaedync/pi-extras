<# Binary stdio only. This process deliberately never imports Hyper-V cmdlets. #>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace PiWindowsTunnel {
    public sealed class HvEndPoint : EndPoint {
        public const AddressFamily Family = (AddressFamily)34;
        public readonly Guid VmId, ServiceId;
        public HvEndPoint(Guid vmId, Guid serviceId) { VmId = vmId; ServiceId = serviceId; }
        public override AddressFamily AddressFamily { get { return Family; } }
        public override SocketAddress Serialize() {
            SocketAddress address = new SocketAddress(Family, 36);
            byte[] vm = VmId.ToByteArray(), service = ServiceId.ToByteArray();
            for (int i = 0; i < 16; i++) { address[4 + i] = vm[i]; address[20 + i] = service[i]; }
            return address;
        }
        public override EndPoint Create(SocketAddress address) {
            if (address.Family != Family || address.Size != 36) throw new ArgumentException("Invalid Hyper-V endpoint");
            byte[] vm = new byte[16], service = new byte[16];
            for (int i = 0; i < 16; i++) { vm[i] = address[4 + i]; service[i] = address[20 + i]; }
            return new HvEndPoint(new Guid(vm), new Guid(service));
        }
    }

    public sealed class Channel {
        const long QueueLimit = 4 * 1024 * 1024;
        readonly Runner owner;
        readonly uint id;
        readonly object gate = new object();
        readonly BlockingCollection<byte[]> queue = new BlockingCollection<byte[]>();
        Socket socket;
        bool opened, finished, readEnded, writeEnded;
        long queuedBytes;
        public Channel(Runner owner, uint id) { this.owner = owner; this.id = id; }

        public void Connect(byte[] json) {
            try {
                Dictionary<string, object> target = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(json));
                int timeout = ReadTimeout(target);
                EndPoint endpoint = ReadEndpoint(target);
                ProtocolType protocol = endpoint.AddressFamily == HvEndPoint.Family ? (ProtocolType)1 : ProtocolType.Tcp;
                Socket candidate = new Socket(endpoint.AddressFamily, SocketType.Stream, protocol);
                lock (gate) {
                    if (finished) { candidate.Close(); throw new IOException("Connection cancelled"); }
                    socket = candidate;
                }
                IAsyncResult pending = candidate.BeginConnect(endpoint, null, null);
                using (WaitHandle wait = pending.AsyncWaitHandle) {
                    if (!wait.WaitOne(timeout)) throw new SocketException((int)SocketError.TimedOut);
                    candidate.EndConnect(pending);
                }
                lock (gate) {
                    if (finished) throw new IOException("Connection cancelled");
                    opened = true;
                    owner.Emit(0x81, id, Runner.Empty);
                }
                Start(Read);
                Start(Write);
            } catch (Exception error) { FailConnect(error); }
        }
        static int ReadTimeout(Dictionary<string, object> target) {
            object value;
            if (!target.TryGetValue("timeoutMs", out value) || !(value is int)) throw new ArgumentException("timeoutMs must be an integer");
            int timeout = (int)value;
            if (timeout < 1 || timeout > 600000) throw new ArgumentException("timeoutMs must be between 1 and 600000");
            return timeout;
        }
        static EndPoint ReadEndpoint(Dictionary<string, object> target) {
            object tcp;
            if (target.TryGetValue("tcp", out tcp)) {
                string text = tcp as string;
                int port;
                if (text == null || !text.StartsWith("127.0.0.1:", StringComparison.Ordinal) ||
                    !Int32.TryParse(text.Substring(10), out port) || port < 1 || port > 65535)
                    throw new ArgumentException("tcp test target must be 127.0.0.1:<port>");
                if (target.ContainsKey("vm") || target.ContainsKey("service")) throw new ArgumentException("Mixed tunnel targets");
                return new IPEndPoint(IPAddress.Loopback, port);
            }
            object vm, service;
            Guid vmId, serviceId;
            if (!target.TryGetValue("vm", out vm) || !target.TryGetValue("service", out service) ||
                !Guid.TryParse(vm as string, out vmId) || !Guid.TryParse(service as string, out serviceId))
                throw new ArgumentException("vm and service must be GUIDs");
            return new HvEndPoint(vmId, serviceId);
        }
        static void Start(ThreadStart action) { Thread thread = new Thread(action); thread.IsBackground = true; thread.Start(); }
        void FailConnect(Exception error) {
            lock (gate) {
                // CLOSE while connecting has no OPENED, therefore cannot produce CLOSED.
                if (opened) { Finish(error.Message); return; }
                finished = true;
                if (socket != null) socket.Close();
                queue.CompleteAdding();
                SocketException socketError = error as SocketException;
                Dictionary<string, object> value = new Dictionary<string, object>();
                value.Add("message", error.Message); value.Add("code", socketError == null ? 0 : socketError.ErrorCode);
                owner.Emit(0x82, id, Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value)));
                owner.Remove(id);
            }
        }
        public void Enqueue(byte[] payload, bool end) {
            lock (gate) {
                if (finished) return;
                if (!opened || writeEnded || queue.IsAddingCompleted) { Finish("Invalid socket write after END or before OPENED"); return; }
                if (end) { queue.Add(Runner.Empty); queue.CompleteAdding(); return; }
                if (payload.Length == 0) return;
                queuedBytes += payload.Length;
                // Dropping only this stream bounds memory without blocking stdin for other guests.
                if (queuedBytes > QueueLimit) { Finish("Tunnel socket write queue exceeded 4 MiB"); return; }
                queue.Add(payload);
            }
        }
        void Write() {
            try {
                foreach (byte[] bytes in queue.GetConsumingEnumerable()) {
                    if (bytes.Length == 0) {
                        socket.Shutdown(SocketShutdown.Send);
                        lock (gate) { writeEnded = true; if (readEnded) Finish(""); }
                        return;
                    }
                    int offset = 0;
                    while (offset < bytes.Length) {
                        int sent = socket.Send(bytes, offset, bytes.Length - offset, SocketFlags.None);
                        if (sent == 0) throw new IOException("Socket stopped accepting data");
                        offset += sent;
                    }
                    lock (gate) { queuedBytes -= bytes.Length; }
                }
            } catch (Exception error) { Finish(error.Message); }
        }
        void Read() {
            try {
                byte[] buffer = new byte[65536];
                while (true) {
                    int count = socket.Receive(buffer);
                    lock (gate) {
                        if (finished) return;
                        if (count == 0) {
                            readEnded = true; owner.Emit(0x84, id, Runner.Empty);
                            if (writeEnded) Finish("");
                            return;
                        }
                        byte[] bytes = new byte[count]; Buffer.BlockCopy(buffer, 0, bytes, 0, count);
                        owner.Emit(0x83, id, bytes);
                    }
                }
            } catch (Exception error) { Finish(error.Message); }
        }
        public void Finish(string error) {
            lock (gate) {
                if (finished) return;
                finished = true;
                if (socket != null) socket.Close();
                queue.CompleteAdding();
                if (opened) { owner.Emit(0x85, id, Encoding.UTF8.GetBytes(error)); owner.Remove(id); }
            }
        }
    }

    public sealed class Runner {
        public static readonly byte[] Empty = new byte[0];
        const uint MaxPayload = 1024 * 1024;
        readonly Stream input = Console.OpenStandardInput();
        readonly Stream output = Console.OpenStandardOutput();
        readonly object outputGate = new object();
        readonly ConcurrentDictionary<uint, Channel> channels = new ConcurrentDictionary<uint, Channel>();
        readonly HashSet<uint> used = new HashSet<uint>();
        public void Emit(byte type, uint id, byte[] payload) {
            byte[] header = new byte[9]; header[0] = type;
            PutUInt(header, 1, id); PutUInt(header, 5, (uint)payload.Length);
            lock (outputGate) {
                try { output.Write(header, 0, 9); output.Write(payload, 0, payload.Length); output.Flush(); }
                catch (Exception error) { Console.Error.WriteLine("Tunnel stdout failed: " + error.Message); Environment.Exit(1); }
            }
        }
        static void PutUInt(byte[] bytes, int offset, uint value) {
            for (int i = 3; i >= 0; i--) { bytes[offset + i] = (byte)value; value >>= 8; }
        }
        static uint GetUInt(byte[] bytes, int offset) {
            uint value = 0; for (int i = 0; i < 4; i++) value = (value << 8) | bytes[offset + i]; return value;
        }
        bool ReadExact(byte[] bytes, bool allowEof) {
            int offset = 0;
            while (offset < bytes.Length) {
                int count = input.Read(bytes, offset, bytes.Length - offset);
                if (count == 0) {
                    if (allowEof && offset == 0) return false;
                    throw new IOException("Truncated tunnel frame");
                }
                offset += count;
            }
            return true;
        }
        public void Remove(uint id) { Channel discarded; channels.TryRemove(id, out discarded); }
        // A VM's id and host key, so a first call over the relay needs no host.ps1,
        // whose startup takes seconds. The key goes back over this private pipe only.
        static byte[] Lookup(byte[] json) {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            Dictionary<string, object> result = new Dictionary<string, object>();
            try {
                Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(json));
                object value;
                string vm = request.TryGetValue("vm", out value) ? value as string : null;
                // WQL escapes with backslashes; names needing escapes go through host.ps1 instead.
                if (String.IsNullOrEmpty(vm) || vm.IndexOf('\'') >= 0 || vm.IndexOf('\\') >= 0) throw new ArgumentException("unsupported VM name");
                ObjectQuery query = new ObjectQuery("SELECT Name FROM Msvm_ComputerSystem WHERE Caption='Virtual Machine' AND ElementName='" + vm + "'");
                // A hung WMI provider would otherwise hold this thread for good.
                EnumerationOptions options = new EnumerationOptions(); options.Timeout = TimeSpan.FromSeconds(5); options.ReturnImmediately = false;
                List<string> ids = new List<string>();
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(new ManagementScope(@"root\virtualization\v2"), query, options))
                using (ManagementObjectCollection found = searcher.Get()) {
                    foreach (ManagementObject machine in found) { using (machine) { ids.Add((string)machine["Name"]); } }
                }
                // Hyper-V allows duplicate names; the key is for one of them, and host.ps1 refuses to guess too.
                if (ids.Count > 1) throw new ArgumentException("more than one VM has that name");
                if (ids.Count == 1) {
                    result.Add("id", ids[0]);
                    // $env:LOCALAPPDATA, as host.ps1 reads it, so both find the same key file.
                    string file = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "pi-extras", "windows-use", Regex.Replace(vm, @"[^\w-]", "_") + ".key");
                    if (File.Exists(file)) result.Add("key", File.ReadAllText(file).Trim());
                }
            } catch (Exception error) { result.Clear(); result.Add("error", error.Message); }
            return Encoding.UTF8.GetBytes(serializer.Serialize(result));
        }
        void Dispatch(byte type, uint id, byte[] payload) {
            if (id == 0 || type < 1 || type > 5) throw new IOException("Invalid tunnel frame type or stream");
            if (type == 5) {
                if (!used.Add(id)) throw new IOException("Reused tunnel stream ID");
                Thread lookup = new Thread(delegate() { Emit(0x86, id, Lookup(payload)); });
                lookup.IsBackground = true; lookup.Start(); return;
            }
            if ((type == 3 || type == 4) && payload.Length != 0) throw new IOException("END and CLOSE must be empty");
            if (type == 1) {
                if (!used.Add(id)) throw new IOException("Reused tunnel stream ID");
                Channel channel = new Channel(this, id); channels.TryAdd(id, channel);
                Thread connect = new Thread(delegate() { channel.Connect(payload); });
                connect.IsBackground = true; connect.Start(); return;
            }
            Channel existing;
            // A CLOSE may race with OPEN_FAILED or a clean finish already written to stdout.
            if (!channels.TryGetValue(id, out existing)) return;
            if (type == 4) existing.Finish(""); else existing.Enqueue(payload, type == 3);
        }
        public static int Run() {
            Runner runner = new Runner();
            try {
                runner.Emit(0x80, 0, Encoding.UTF8.GetBytes("{\"version\":1}"));
                byte[] header = new byte[9];
                while (runner.ReadExact(header, true)) {
                    uint length = GetUInt(header, 5);
                    if (length > MaxPayload) throw new IOException("Tunnel frame payload exceeds 1 MiB");
                    byte[] payload = new byte[length]; runner.ReadExact(payload, false);
                    runner.Dispatch(header[0], GetUInt(header, 1), payload);
                }
                return 0;
            } catch (Exception error) { Console.Error.WriteLine("Tunnel protocol failed: " + error.Message); return 1; }
            finally { foreach (Channel channel in runner.channels.Values) channel.Finish(""); }
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Management.dll', 'System.Web.Extensions.dll') | Out-Null
    $result = [PiWindowsTunnel.Runner]::Run()
    exit $result
} catch {
    [Console]::Error.WriteLine('Tunnel startup failed: ' + $_.Exception.Message)
    exit 1
}
