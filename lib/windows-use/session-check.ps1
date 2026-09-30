# Query the calling desktop, not inherited environment variables or localized quser text.
$ErrorActionPreference = 'Stop'
if (-not ('PiWindowsUse.Session' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace PiWindowsUse {
    public static class Session {
        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int info, out IntPtr buffer, out uint bytes);
        [DllImport("wtsapi32.dll")]
        private static extern void WTSFreeMemory(IntPtr buffer);
        public static int State(uint session) {
            IntPtr buffer = IntPtr.Zero;
            uint bytes = 0;
            try {
                // WTSConnectState (8) is a WTS_CONNECTSTATE_CLASS, independent of locale.
                if (!WTSQuerySessionInformationW(IntPtr.Zero, session, 8, out buffer, out bytes))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (buffer == IntPtr.Zero || bytes < 4) throw new InvalidOperationException("Missing WTS state");
                return Marshal.ReadInt32(buffer);
            } finally {
                if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
            }
        }
    }
}
'@
}
$me = (Get-Process -Id $PID).SessionId
$locked = [bool](Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me })
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$state = [ordered]@{
    id = $me
    console = [PiWindowsUse.Session]::WTSGetActiveConsoleSessionId()
    state = [PiWindowsUse.Session]::State($me)
    locked = $locked
    elevated = $admin
}
'PI_WINDOWS_SESSION=' + (ConvertTo-Json -InputObject $state -Compress)
