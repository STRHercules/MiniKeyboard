#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Backend for the KEY_PRO configurator. Wire format: see PROTOCOL.md ("Key slots", "LED").

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::ErrorKind,
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Mutex, OnceLock},
    thread::sleep,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const VIDS: [u16; 2] = [0x1189, 0x514C];
const PIDS: [u16; 8] = [0x8842, 0x8840, 0x8830, 0x8831, 0x8832, 0x8833, 0x8850, 0x8851];
const CONFIG_USAGE_PAGE: u16 = 0xFF00;
const LAYERS: u8 = 3;
const SLOTS: u8 = 24; // 15 keys + 3 knobs x 3, the firmware always reports all of them
const MAX_STEPS: usize = 18;
const SETTLE: Duration = Duration::from_millis(200);

type Report = [u8; 65];

fn report(payload: &[u8]) -> Report {
    let mut r = [0u8; 65];
    r[0] = 0x03;
    r[1..=payload.len()].copy_from_slice(payload);
    r
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Step {
    mods: u8,
    code: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    /// One step = keystroke or combination; several steps + interval = macro.
    Keys { steps: Vec<Step>, interval: u16 },
    /// 16-bit HID consumer usage (volume, media, brightness, ...).
    Media { usage: u16 },
    Mouse { mods: u8, buttons: u8, wheel: i8 },
}

fn encode(layer: u8, slot: u8, action: &Action) -> Result<Report, String> {
    if !(1..=LAYERS).contains(&layer) || !(1..=SLOTS).contains(&slot) {
        return Err(format!("layer {layer} / slot {slot} out of range"));
    }
    let mut r = [0u8; 65];
    r[0] = 0x03;
    r[1] = 0xFD;
    r[2] = slot;
    r[3] = layer;
    match action {
        Action::Keys { steps, interval } => {
            if steps.len() > MAX_STEPS {
                return Err(format!("at most {MAX_STEPS} steps"));
            }
            r[4] = 1;
            r[5..7].copy_from_slice(&interval.to_le_bytes());
            r[10] = steps.len() as u8;
            for (i, s) in steps.iter().enumerate() {
                r[11 + 2 * i] = s.mods;
                r[12 + 2 * i] = s.code;
            }
        }
        Action::Media { usage } => {
            r[4] = 2;
            r[10] = 2;
            r[11..13].copy_from_slice(&usage.to_le_bytes());
        }
        Action::Mouse { mods, buttons, wheel } => {
            r[4] = 3;
            r[10] = 1;
            r[11] = *mods;
            r[12] = *buttons;
            r[15] = *wheel as u8;
        }
    }
    Ok(r)
}

/// Decodes a `FA` response. The firmware echoes the interval big-endian although it takes it little-endian.
fn decode(r: &Report) -> Action {
    match r[4] {
        2 => Action::Media { usage: u16::from_le_bytes([r[11], r[12]]) },
        3 => Action::Mouse { mods: r[11], buttons: r[12], wheel: r[15] as i8 },
        _ => Action::Keys {
            interval: u16::from_be_bytes([r[5], r[6]]),
            steps: (0..(r[10] as usize).min(MAX_STEPS))
                .map(|i| Step { mods: r[11 + 2 * i], code: r[12 + 2 * i] })
                .collect(),
        },
    }
}

struct Dev {
    _api: hidapi::HidApi,
    hid: hidapi::HidDevice,
    vid: u16,
    pid: u16,
}

impl Dev {
    fn open() -> Result<Dev, String> {
        let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
        let known = |d: &&hidapi::DeviceInfo| VIDS.contains(&d.vendor_id()) && PIDS.contains(&d.product_id());
        let info = api
            .device_list()
            .filter(known)
            .find(|d| d.usage_page() == CONFIG_USAGE_PAGE)
            .or_else(|| api.device_list().find(known))
            .ok_or("keyboard not found")?;
        let (vid, pid) = (info.vendor_id(), info.product_id());
        let hid = info.open_device(&api).map_err(|e| e.to_string())?;
        Ok(Dev { _api: api, hid, vid, pid })
    }

    fn send(&self, r: &Report) -> Result<(), String> {
        self.hid.write(r).map(|_| ()).map_err(|e| e.to_string())
    }

    fn recv(&self, ms: i32) -> Result<Option<Report>, String> {
        let mut b = [0u8; 65];
        let n = self.hid.read_timeout(&mut b, ms).map_err(|e| e.to_string())?;
        Ok((n > 0).then_some(b))
    }

    fn drain(&self) {
        while matches!(self.recv(10), Ok(Some(_))) {}
    }

    fn commit(&self) -> Result<(), String> {
        self.send(&report(&[0xFD, 0xFE, 0xFF]))?;
        sleep(SETTLE);
        Ok(())
    }
}

#[derive(Serialize)]
struct DeviceInfo {
    vid: u16,
    pid: u16,
    keys: u8,
    knobs: u8,
    device_type: u8,
}

#[derive(Serialize)]
struct Slot {
    layer: u8,
    slot: u8,
    action: Action,
}

#[derive(Deserialize)]
struct Change {
    layer: u8,
    slot: u8,
    action: Action,
}

#[derive(Serialize)]
struct HidEntry {
    vid: u16,
    pid: u16,
    usage_page: u16,
    product: Option<String>,
}

#[tauri::command]
async fn list_devices() -> Result<Vec<HidEntry>, String> {
    let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
    Ok(api
        .device_list()
        .filter(|d| VIDS.contains(&d.vendor_id()))
        .map(|d| HidEntry {
            vid: d.vendor_id(),
            pid: d.product_id(),
            usage_page: d.usage_page(),
            product: d.product_string().map(str::to_owned),
        })
        .collect())
}

#[tauri::command]
async fn handshake() -> Result<DeviceInfo, String> {
    let dev = Dev::open()?;
    dev.drain();
    dev.send(&report(&[0xFB, 0xFB, 0xFB]))?;
    let r = dev.recv(300)?.ok_or("keyboard did not answer")?;
    Ok(DeviceInfo { vid: dev.vid, pid: dev.pid, keys: r[2], knobs: r[3], device_type: r[4] })
}

#[tauri::command]
async fn read_slots() -> Result<Vec<Slot>, String> {
    let dev = Dev::open()?;
    let mut out = Vec::new();
    for layer in 1..=LAYERS {
        dev.drain();
        dev.send(&report(&[0xFA, 0x0F, 0x03, layer]))?;
        for _ in 0..SLOTS {
            let r = dev.recv(300)?.ok_or("keyboard stopped answering while reading")?;
            out.push(Slot { layer, slot: r[2], action: decode(&r) });
        }
    }
    Ok(out)
}

#[tauri::command]
async fn write_slots(changes: Vec<Change>) -> Result<(), String> {
    let reports = changes
        .iter()
        .map(|c| encode(c.layer, c.slot, &c.action))
        .collect::<Result<Vec<_>, _>>()?;
    let dev = Dev::open()?;
    for r in &reports {
        dev.send(r)?;
        sleep(Duration::from_millis(10));
    }
    dev.commit()
}

/// `led` = colour nibble << 4 | mode nibble (known: colour 1..=7, mode 0..=5); `extra` fills r13.. so unknown
/// firmware parameters can be probed. The firmware cannot be read back.
#[tauri::command]
async fn set_led(layer: u8, led: u8, extra: Vec<u8>) -> Result<(), String> {
    if !(1..=LAYERS).contains(&layer) || extra.len() > 8 {
        return Err("LED layer/extra out of range".into());
    }
    let mut r = report(&[0xFE, 0xB0, layer, 0x08]);
    r[10] = 1;
    r[12] = led;
    r[13..13 + extra.len()].copy_from_slice(&extra);
    let dev = Dev::open()?;
    dev.send(&r)?;
    dev.commit()
}

#[tauri::command]
async fn clean_device_data() -> Result<(), String> {
    Dev::open()?.send(&report(&[0xEF]))
}

fn store_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("store.json"))
}

/// Macro library and last-applied LED settings live in one JSON document owned by the frontend.
#[tauri::command]
fn load_store(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(store_path(&app)?) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_store(app: tauri::AppHandle, data: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| e.to_string())?;
    fs::write(store_path(&app)?, data).map_err(|e| e.to_string())
}

#[derive(Deserialize, Clone)]
struct BAction {
    /// "press" | "release" | "held" (starts on press, ends on release)
    when: String,
    /// "app" | "script" | "sound" | "key" | "type" | "paste"
    kind: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    volume: u8,
    #[serde(default)]
    looped: bool,
    #[serde(default)]
    mods: u8,
    #[serde(default)]
    code: u8,
    /// "type" / "paste": the text, whether to press Enter afterwards, ms between typed characters, restore the clipboard
    #[serde(default)]
    text: String,
    #[serde(default)]
    send: bool,
    #[serde(default)]
    delay_ms: u32,
    #[serde(default)]
    restore: bool,
}

/// One keyboard key = one global hotkey (the key sends it) with any number of actions on its press/release.
#[derive(Deserialize, Clone)]
struct Binding {
    /// e.g. "Ctrl+Shift+Alt+F13"
    shortcut: String,
    actions: Vec<BAction>,
}

#[derive(Serialize, Clone)]
struct SoundCmd {
    id: String,
    cmd: &'static str,
    path: String,
    volume: u8,
    looped: bool,
}

/// HID usage -> (PS/2 set 1 scancode, extended) for key injection.
fn hid_scan(code: u8) -> Option<(u16, bool)> {
    const LETTERS: [u16; 26] = [
        0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14,
        0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C,
    ];
    let c = code as u16;
    Some(match code {
        4..=29 => (LETTERS[(code - 4) as usize], false),
        30..=38 => (0x02 + (c - 30), false),
        39 => (0x0B, false),
        40 => (0x1C, false), 41 => (0x01, false), 42 => (0x0E, false), 43 => (0x0F, false), 44 => (0x39, false),
        45 => (0x0C, false), 46 => (0x0D, false), 47 => (0x1A, false), 48 => (0x1B, false), 49 => (0x2B, false),
        51 => (0x27, false), 52 => (0x28, false), 53 => (0x29, false), 54 => (0x33, false), 55 => (0x34, false), 56 => (0x35, false),
        57 => (0x3A, false),
        58..=67 => (0x3B + (c - 58), false),
        68 => (0x57, false), 69 => (0x58, false),
        70 => (0x37, true), 71 => (0x46, false),
        73 => (0x52, true), 74 => (0x47, true), 75 => (0x49, true), 76 => (0x53, true), 77 => (0x4F, true), 78 => (0x51, true),
        79 => (0x4D, true), 80 => (0x4B, true), 81 => (0x50, true), 82 => (0x48, true),
        83 => (0x45, false), 84 => (0x35, true), 85 => (0x37, false), 86 => (0x4A, false), 87 => (0x4E, false), 88 => (0x1C, true),
        89 => (0x4F, false), 90 => (0x50, false), 91 => (0x51, false), 92 => (0x4B, false), 93 => (0x4C, false), 94 => (0x4D, false),
        95 => (0x47, false), 96 => (0x48, false), 97 => (0x49, false), 98 => (0x52, false), 99 => (0x53, false),
        100 => (0x56, false), 101 => (0x5D, true),
        104..=111 => (0x64 + (c - 104), false),
        112..=114 => (0x6C + (c - 112), false),
        115 => (0x76, false),
        _ => return None,
    })
}

/// (HID modifier bit, scancode, extended)
const MOD_SCANS: [(u8, u16, bool); 8] = [
    (0x01, 0x1D, false), (0x02, 0x2A, false), (0x04, 0x38, false), (0x08, 0x5B, true),
    (0x10, 0x1D, true), (0x20, 0x36, false), (0x40, 0x38, true), (0x80, 0x5C, true),
];

/// Sends raw keyboard events: (scancode or UTF-16 unit, extended, key up, unicode).
fn inject(events: &[(u16, bool, bool, bool)]) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    let inputs: Vec<INPUT> = events
        .iter()
        .map(|&(code, ext, up, unicode)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: 0,
                    wScan: code,
                    dwFlags: if unicode { KEYEVENTF_UNICODE } else { KEYEVENTF_SCANCODE }
                        | if ext { KEYEVENTF_EXTENDEDKEY } else { 0 }
                        | if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
}

/// The trigger hotkey's Ctrl+Shift+Alt are still held by the keyboard while an action runs; lift them
/// so they do not turn injected keys into shortcuts.
fn lift_trigger_mods() {
    let ev: Vec<_> = MOD_SCANS.iter().take(3).map(|&(_, sc, ext)| (sc, ext, true, false)).collect();
    inject(&ev);
}

/// Presses (`down`) or releases a key plus modifiers.
fn send_key(mods: u8, code: u8, down: bool) {
    let key = hid_scan(code);
    let mut ev: Vec<(u16, bool, bool, bool)> = Vec::new();
    if down {
        lift_trigger_mods();
        ev.extend(MOD_SCANS.iter().filter(|m| mods & m.0 != 0).map(|&(_, sc, ext)| (sc, ext, false, false)));
        ev.extend(key.map(|(sc, ext)| (sc, ext, false, false)));
    } else {
        ev.extend(key.map(|(sc, ext)| (sc, ext, true, false)));
        ev.extend(MOD_SCANS.iter().rev().filter(|m| mods & m.0 != 0).map(|&(_, sc, ext)| (sc, ext, true, false)));
    }
    inject(&ev);
}

fn tap(code: u8) {
    send_key(0, code, true);
    send_key(0, code, false);
}

static TYPING: Mutex<()> = Mutex::new(());

fn type_text(text: &str, delay_ms: u32) {
    for ch in text.chars() {
        match ch {
            '\r' => continue,
            '\n' => tap(0x28),
            '\t' => tap(0x2B),
            _ => {
                let mut buf = [0u16; 2];
                for unit in ch.encode_utf16(&mut buf) {
                    inject(&[(*unit, false, false, true), (*unit, false, true, true)]);
                }
            }
        }
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms as u64));
        }
    }
}

fn paste_text(text: &str, restore: bool) {
    let Ok(mut cb) = arboard::Clipboard::new() else { return };
    let previous = cb.get_text().ok();
    if cb.set_text(text).is_err() {
        return;
    }
    sleep(Duration::from_millis(60));
    send_key(0x01, 0x19, true); // Ctrl+V
    send_key(0x01, 0x19, false);
    if let (true, Some(prev)) = (restore, previous) {
        sleep(Duration::from_millis(250)); // let the target app read the clipboard first
        let _ = cb.set_text(prev);
    }
}

/// Typing and pasting take a while, so they run off the hotkey thread, one at a time.
fn text_action(a: BAction) {
    std::thread::spawn(move || {
        let _one_at_a_time = TYPING.lock().unwrap_or_else(|e| e.into_inner());
        lift_trigger_mods();
        if a.kind == "paste" { paste_text(&a.text, a.restore) } else { type_text(&a.text, a.delay_ms) }
        if a.send {
            sleep(Duration::from_millis(40));
            tap(0x28);
        }
    });
}

fn perform(app: &tauri::AppHandle, id: &str, a: &BAction, pressed: bool) {
    match (a.when.as_str(), pressed) {
        ("press", true) | ("release", false) | ("held", _) => {}
        _ => return,
    }
    match a.kind.as_str() {
        "sound" => {
            let held = a.when == "held";
            let cmd = if held && !pressed { "stop" } else { "play" };
            let _ = app.emit("sound", SoundCmd { id: id.into(), cmd, path: a.target.clone(), volume: a.volume, looped: a.looped && held });
        }
        "type" | "paste" if a.when != "held" => text_action(a.clone()),
        "key" if a.when == "held" => send_key(a.mods, a.code, pressed),
        "key" => {
            send_key(a.mods, a.code, true);
            send_key(a.mods, a.code, false);
        }
        "type" | "paste" => {}
        _ if pressed || a.when == "release" => {
            let _ = run(a);
        }
        _ => {}
    }
}

fn run(l: &BAction) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::Command};
    let ext = std::path::Path::new(&l.target).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mut cmd = match (l.kind.as_str(), ext.as_str()) {
        ("script", "ps1") => {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &l.target]);
            c
        }
        ("script", "bat" | "cmd") => {
            let mut c = Command::new("cmd");
            c.args(["/c", &l.target]);
            c
        }
        ("script", "py") => {
            let mut c = Command::new("python");
            c.arg(&l.target);
            c
        }
        _ => Command::new(&l.target),
    };
    cmd.args(l.args.split_whitespace());
    if l.hidden {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Some(dir) = std::path::Path::new(&l.target).parent().filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("{}: {e}", l.target))
}

#[derive(Deserialize, Clone)]
struct LayerKey {
    shortcut: String,
    /// "goto" | "toggle" | "cycle" | "hold"
    mode: String,
    /// 1-based layer, unused by "cycle"
    target: u8,
}

#[derive(Deserialize)]
struct HotkeyConfig {
    bindings: Vec<Binding>,
    layer_keys: Vec<LayerKey>,
    /// Software layer i as slot -> action; maps[active] must equal what device layer 1 holds now.
    maps: Vec<HashMap<u8, Action>>,
    /// Raw LED byte per software layer, if known.
    led: Vec<Option<u8>>,
    active: usize,
}

/// Software layers: the keyboard only ever uses its layer 1, so a switch rewrites the slots that
/// differ. Every switch is a flash write; see the caveat in the UI.
struct Layers {
    maps: Vec<HashMap<u8, Action>>,
    led: Vec<Option<u8>>,
    active: usize,
    held: HashMap<String, usize>,
}

static SOFT_LAYERS: Mutex<Option<Layers>> = Mutex::new(None);
static LAYER_EVENTS: OnceLock<mpsc::Sender<(LayerKey, bool)>> = OnceLock::new();

fn switch_to(app: &tauri::AppHandle, st: &mut Layers, to: usize) -> Result<(), String> {
    if to == st.active || to >= st.maps.len() {
        return Ok(());
    }
    let dev = Dev::open()?;
    let mut wrote = false;
    for (slot, a) in &st.maps[to] {
        if st.maps[st.active].get(slot) != Some(a) {
            dev.send(&encode(1, *slot, a)?)?;
            sleep(Duration::from_millis(10));
            wrote = true;
        }
    }
    if let Some(Some(led)) = st.led.get(to) {
        let mut r = report(&[0xFE, 0xB0, 1, 0x08]);
        r[10] = 1;
        r[12] = *led;
        dev.send(&r)?;
        wrote = true;
    }
    if wrote {
        dev.commit()?;
    }
    st.active = to;
    let _ = app.emit("layer", to);
    Ok(())
}

fn on_layer_key(app: &tauri::AppHandle, lk: &LayerKey, pressed: bool) -> Result<(), String> {
    let mut guard = SOFT_LAYERS.lock().unwrap();
    let st = guard.as_mut().ok_or("layers are not configured")?;
    let n = st.maps.len();
    if n == 0 {
        return Ok(());
    }
    let t = (lk.target as usize).saturating_sub(1).min(n - 1);
    let to = match (lk.mode.as_str(), pressed) {
        ("goto", true) => Some(t),
        ("toggle", true) => Some(if st.active == t { 0 } else { t }),
        ("cycle", true) => Some((st.active + 1) % n),
        ("hold", true) => {
            st.held.insert(lk.shortcut.clone(), st.active);
            Some(t)
        }
        ("hold", false) => Some(st.held.remove(&lk.shortcut).unwrap_or(0)),
        _ => None,
    };
    to.map_or(Ok(()), |to| switch_to(app, st, to))
}

/// Replaces every registered hotkey and the software-layer state. Returns the shortcuts that could not be registered.
#[tauri::command]
fn set_hotkeys(app: tauri::AppHandle, cfg: HotkeyConfig) -> Result<Vec<String>, String> {
    *SOFT_LAYERS.lock().unwrap() = Some(Layers { maps: cfg.maps, led: cfg.led, active: cfg.active, held: HashMap::new() });
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let mut failed = Vec::new();
    let mut register = |shortcut: &str, handler: Box<dyn Fn(bool) + Send + Sync>| {
        let reg = shortcut.parse::<Shortcut>().map_err(|e| e.to_string()).and_then(|sc| {
            gs.on_shortcut(sc, move |_, _, ev| handler(ev.state() == ShortcutState::Pressed)).map_err(|e| e.to_string())
        });
        if reg.is_err() {
            failed.push(shortcut.to_owned());
        }
    };
    for (bi, b) in cfg.bindings.into_iter().enumerate() {
        let shortcut = b.shortcut.clone();
        let app = app.clone();
        register(&shortcut, Box::new(move |pressed| {
            for (i, a) in b.actions.iter().enumerate() {
                perform(&app, &format!("{bi}:{i}"), a, pressed);
            }
        }));
    }
    for lk in cfg.layer_keys {
        let shortcut = lk.shortcut.clone();
        register(&shortcut, Box::new(move |pressed| {
            if let Some(tx) = LAYER_EVENTS.get() {
                let _ = tx.send((lk.clone(), pressed));
            }
        }));
    }
    Ok(failed)
}

/// Used by the UI to return to layer 1 before it edits the keyboard.
#[tauri::command]
async fn layers_goto(app: tauri::AppHandle, to: usize) -> Result<(), String> {
    let mut guard = SOFT_LAYERS.lock().unwrap();
    match guard.as_mut() {
        Some(st) => switch_to(&app, st, to),
        None => Ok(()),
    }
}

#[tauri::command]
fn launch_now(item: BAction) -> Result<(), String> {
    run(&item)
}

const AUDIO_EXT: [&str; 5] = ["mp3", "wav", "ogg", "flac", "m4a"];

/// Raw bytes of an audio file for the webview to play (only audio extensions are served).
#[tauri::command]
fn read_audio(path: String) -> Result<tauri::ipc::Response, String> {
    let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !AUDIO_EXT.contains(&ext.as_str()) {
        return Err("not an audio file".into());
    }
    fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn set_close_to_tray(on: bool) {
    CLOSE_TO_TRAY.store(on, Ordering::Relaxed);
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[tauri::command]
fn get_autostart() -> bool {
    use std::{os::windows::process::CommandExt, process::Command};
    Command::new("reg").args(["query", RUN_KEY, "/v", "MiniKeyboard"]).creation_flags(0x0800_0000).output().map(|o| o.status.success()).unwrap_or(false)
}

/// Starts the app hidden in the tray at login (HKCU Run key, no admin needed).
#[tauri::command]
fn set_autostart(on: bool) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::Command};
    let mut cmd = Command::new("reg");
    if on {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        cmd.args(["add", RUN_KEY, "/v", "MiniKeyboard", "/t", "REG_SZ", "/d", &format!("\"{}\" --hidden", exe.display()), "/f"]);
    } else {
        cmd.args(["delete", RUN_KEY, "/v", "MiniKeyboard", "/f"]);
    }
    cmd.creation_flags(0x0800_0000).output().map_err(|e| e.to_string()).and_then(|o| if o.status.success() || !on { Ok(()) } else { Err("could not update the startup entry".into()) })
}

#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = store_path(&app)?.parent().map(|p| p.to_owned()).ok_or("no data folder")?;
    std::process::Command::new("explorer").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_settings(app: tauri::AppHandle, data: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app.dialog().file().add_filter("JSON", &["json"]).set_file_name("minikeyboard-settings.json").blocking_save_file() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Returns the chosen file's JSON text (validated); the UI decides how to merge it.
#[tauri::command]
async fn import_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file() else { return Ok(None) };
    let text = fs::read_to_string(path.into_path().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
async fn pick_sounds(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().add_filter("Audio", &AUDIO_EXT).blocking_pick_files().unwrap_or_default();
    picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
async fn pick_file(app: tauri::AppHandle, kind: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let d = app.dialog().file();
    let d = match kind.as_str() {
        "script" => d.add_filter("Scripts", &["ps1", "bat", "cmd", "py", "sh", "exe"]),
        "sound" => d.add_filter("Audio", &AUDIO_EXT),
        _ => d.add_filter("Programs", &["exe", "lnk", "bat", "cmd"]),
    };
    d.blocking_pick_file().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            let (tx, rx) = mpsc::channel();
            let _ = LAYER_EVENTS.set(tx);
            let handle = app.handle().clone();
            // One worker keeps press/release events in order while the slow flash writes happen.
            std::thread::spawn(move || {
                for (lk, pressed) in rx {
                    if let Err(e) = on_layer_key(&handle, &lk, pressed) {
                        let _ = handle.emit("layer-error", e);
                    }
                }
            });
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "show", "Open configurator", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("MiniKeyboard — launchers active")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Closing hides to the tray so launcher hotkeys keep working; quit from the tray menu.
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                } else {
                    w.app_handle().exit(0);
                }
            }
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_devices,
            handshake,
            read_slots,
            write_slots,
            set_led,
            clean_device_data,
            load_store,
            save_store,
            set_hotkeys,
            layers_goto,
            launch_now,
            pick_file,
            read_audio,
            pick_sounds,
            copy_text,
            read_clipboard,
            set_close_to_tray,
            get_autostart,
            set_autostart,
            open_data_dir,
            export_settings,
            import_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_through_the_interval_byte_swap() {
        let a = Action::Keys { steps: vec![Step { mods: 1, code: 6 }, Step { mods: 0, code: 5 }], interval: 300 };
        let mut r = encode(1, 5, &a).unwrap();
        assert_eq!(&r[1..8], &[0xFD, 5, 1, 1, 0x2C, 0x01, 0]);
        assert_eq!(&r[10..14], &[2, 1, 6, 0]);
        r.swap(5, 6); // what the firmware reports back
        assert_eq!(decode(&r), a);
    }

    #[test]
    fn media_and_mouse_layout() {
        let m = encode(2, 1, &Action::Media { usage: 0x0223 }).unwrap();
        assert_eq!((m[4], m[11], m[12]), (2, 0x23, 0x02));
        let w = Action::Mouse { mods: 1, buttons: 0, wheel: -1 };
        let r = encode(3, 2, &w).unwrap();
        assert_eq!((r[4], r[11], r[15]), (3, 1, 0xFF));
        assert_eq!(decode(&r), w);
    }

    /// Read-only check against real hardware: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn reads_the_connected_keyboard() {
        let info = tauri::async_runtime::block_on(handshake()).unwrap();
        let slots = tauri::async_runtime::block_on(read_slots()).unwrap();
        assert_eq!(slots.len(), (LAYERS * SLOTS) as usize);
        eprintln!("{} keys, {} knobs, slot 1/1 = {:?}", info.keys, info.knobs, slots[0].action);
    }

    #[test]
    fn scancodes_for_injection() {
        assert_eq!(hid_scan(4), Some((0x1E, false))); // A
        assert_eq!(hid_scan(39), Some((0x0B, false))); // 0
        assert_eq!(hid_scan(81), Some((0x50, true))); // Down arrow is extended
        assert_eq!(hid_scan(98), Some((0x52, false))); // Numpad 0 is not
        assert_eq!(hid_scan(115), Some((0x76, false))); // F24
        assert_eq!(hid_scan(0), None);
    }

    #[test]
    fn rejects_bad_input() {
        let long = Action::Keys { steps: vec![Step { mods: 0, code: 4 }; MAX_STEPS + 1], interval: 0 };
        assert!(encode(1, 1, &long).is_err());
        assert!(encode(4, 1, &Action::Media { usage: 1 }).is_err());
    }
}
