export const DISPLAY_SETTINGS_EVENT="pi-extras:tool-display-settings";
const key=Symbol.for("pi-extras.phase-spinner.test-verbs");
export const setVerbs=value=>{globalThis[key]=value;};
export const readSection=name=>name==="phaseSpinner"?{verbs:globalThis[key]}:{};
