# Mini Keyboard (KEY_PRO) HID Protocol

Reverse-engineered from `_Original/MINI_KEYBOARD.exe` (Qt 5.14.2 / MinGW, debug build)
using IDA Pro 9.5 + Hex-Rays. Device is a USB HID keyboard configured through
report ID `0x03` with 65-byte reports (report ID + 64 payload).

## Device enumeration

Tried in order (VID, PID):

- VID `0x1189`, PIDs `0x8842 0x8840 0x8830 0x8831 0x8832 0x8833 0x8850 0x8851`
- Fallback VID `0x514C`, same PIDs

The first device whose `hid_enumerate()` returns a non-null entry with a usable
interface is opened via `hid_open_path(info[0])`. The enumeration handle is freed
afterwards.

Global state:
- connected flag at `byte_64BD58` (1 = connected)
- deviceVersion word at `word_64BD54` / `word_4BE190`
- deviceType byte at `byte_64BD56` / `byte_4BE192` (10 = "type 10", else other)

## Handshake (get device info)

Request (65 bytes, report ID `0x03`):
```
03 FB FB FB 00 00 ... 00
```
(only first 4 bytes set; rest zero)

Response (65 bytes as returned by hidapi, byte 0 is the report ID `03`; the original
reads 64 so its indices are the same). Verified on a 5-key unit (VID 514C, PID 8851):
- byte[2] -> key count, byte[3] -> knob count (together the "version" word `word_64BD54`)
- byte[4] -> device type -> `byte_64BD56` (10 = per-key RGB model, anything else = "slot" model below)
- (earlier notes had these at [6..8]; that was an IDA indexing slip)

Then `sub_4715F0()` rebuilds the UI for the connected device.

## Read physical key data (command 0xFA)

Request header used in `sub_40D750`:
```
03 FA B0 <deviceType>
```
followed by 61 zero bytes.

Response (64 bytes):
- byte[2] -> key count / status -> `byte_64BD63[layer]`
- bytes[3..50] -> 48 key values -> `byte_4BE100[layer*48 + i]`

`sub_414B70` issues the same `0xFA` request with a layer index and reads back
up to 16 blocks of 48 bytes into `byte_6461E0` / `byte_648FA0` (PHY / PHY2 key
value tables, 3900 bytes per layer).

## Set a single key (command 0xFC)

Request (65 bytes):
```
03 FC FC <keycodeLow> <keycodeHigh> <modifier> 00...
```
- report ID `0x03`
- command `0xFC`
- subcommand `0xFC`
- 16-bit keycode (little-endian)
- modifier byte (0 or 1)

After writing, the firmware is told to re-download (`sub_40BD20`) and re-handshake.

## Clean device data (command 0xEF)

Request:
```
03 EF 00 00 00 00 ... 00
```
Writes a 65-byte report with command `0xEF`. No response read.

## Download keymap (command 0xFE)

Request header:
```
03 FE <64 bytes of keymap data>
```
Keymap table `byte_6461DF` is 60 entries x 65 bytes (3900 bytes). Only entries
whose dirty flag `byte_646120[i] == 1` are sent. Each entry is written as a full
65-byte report. After each successful write the dirty flag is cleared.

After all dirty entries:
- if `byte_64BD62 == 1`, write LED color block:
  ```
  03 FE B0 <layer> <colorByte> <48 bytes from byte_4BE100>
  ```
  for layers 0..2
- write commit report:
  ```
  03 FD FE FF 00 ... 00
  ```
- `Sleep(200 ms)`

## Connection check / keepalive

`sub_472240` writes the handshake request `03 FB FB FB...` and reads the
response with a 10 ms timeout. If a response arrives, the device is considered
connected and `sub_4715F0()` refreshes the UI. If it times out, the connection
dialog is shown.

## Key tables in the application

- `byte_646120[180]`  dirty flags for keymap entries
- `byte_6461DF[3900]` keymap download buffer (60 x 65)
- `byte_648F9F[...]`   PHY key values
- `byte_6461E0[...]`   PHY2 key values
- `byte_4BE100[48*layers]` LED color data
- `byte_64BD63[3]`     per-layer key counts

## Notes

- All multi-byte integers are little-endian.
- Report length is always 65 bytes including the report ID byte.
- The original application is 32-bit, but the client now auto-loads a 64-bit
  `hidapi64.dll` (bundled from OpenRGB) when running under 64-bit Python.
""", filePath="R:\Users\Zach\Documents\GitHub\MiniKeyboard\PROTOCOL.md")
## Key slots (non-type-10 devices) — verified on hardware

Configuration interface is HID usage page `0xFF00` (MI_00). Each layer (1..3) holds 24 slots:
ids 1..15 = keys, 0x10..0x18 = three knobs x (0x12+3k, 0x11+3k, 0x10+3k), presumed turn-left /
press / turn-right. The firmware always reports all 24 whatever the real key count.

Read all slots of a layer: `03 FA 0F 03 <layer>` -> 24 responses of 65 bytes each.
Write one slot: same layout with byte 1 = `FD`, then commit with `03 FD FE FF` (the original waits 200 ms).

```
r0 03 | r1 FA (read) / FD (write) | r2 slot id | r3 layer 1..3 | r4 mode
r5,r6 interval ms (write: lo,hi; firmware reads back hi,lo)   r10 count
r11.. payload
```
Only 50 bytes (r1..r50) are sent by the original. Modes the firmware accepts: 1, 2, 3 (anything else
is ignored and the old mode stays, even though the original UI tabs use 5/8 internally).

- mode 1 keys: `r10` = steps, step i = (`r11+2i` modifiers, `r12+2i` HID keycode). One step = keystroke
  or combination; several steps with a non-zero interval = macro (max 18 in the original UI).
  Modifier bits are standard HID: 01 Ctrl, 02 Shift, 04 Alt, 08 Win, 10..80 the right-hand ones.
- mode 2 media: `r11,r12` = 16-bit consumer usage little-endian (`r10` is normalised to 1 by the firmware).
  Volume up 0x00E9, mute 0x00E2, play/pause 0x00CD, brightness+ 0x006F, calculator 0x0192, WWW home 0x0223, ...
- mode 3 mouse: `r11` keyboard modifiers, `r12` buttons (1 left, 2 right, 4 middle), `r13/r14` x/y,
  `r15` wheel (int8, 0xFF = down). The firmware normalises `r10` to 4.

Round trip was checked by writing every mode to a scratch slot, reading it back and restoring it.

## LED (non-type-10) — from the original's code, not read-back verifiable

One entry per layer: `03 FE B0 <layer 1..3> 08 00 00 00 00 00 01 00 <led>` then the commit above,
where `led = colour << 4 | mode`, colour 1..7 = red, orange, yellow, green, cyan, blue, purple and
mode 0..5 = Off, Static, Reactive, Reactive alternate, When pressed, Cycle (Cycle ignores the colour). The firmware does not report LED state, and no brightness command exists for this model.

The app also exposes the colour/mode nibbles up to 15 and bytes r13..r16 for probing; their effect is unknown.
