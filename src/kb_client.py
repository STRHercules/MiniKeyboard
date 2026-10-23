"""Client for the Mini Keyboard (KEY_PRO) HID protocol.

Requires a 32-bit Python (the shipped hidapi.dll is 32-bit) and the DLL at
_Original/hidapi.dll. Usage:

    python src/kb_client.py --vid 0x1189 --pid 0x8842
"""

import ctypes
import os
import struct
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ctypes.sizeof(ctypes.c_void_p) == 8:
    DLL_CANDIDATES = [
        os.path.join(BASE, "_Original", "hidapi64.dll"),
        r"C:\Program Files\OpenRGB\hidapi.dll",
    ]
else:
    DLL_CANDIDATES = [
        os.path.join(BASE, "_Original", "hidapi.dll"),
    ]

# hid_device_info (32-bit layout)
class HidDeviceInfo(ctypes.Structure):
    pass

HidDeviceInfo._fields_ = [
    ("path", ctypes.c_char_p),
    ("vendor_id", ctypes.c_ushort),
    ("product_id", ctypes.c_ushort),
    ("serial_number", ctypes.c_wchar_p),
    ("release_number", ctypes.c_ushort),
    ("manufacturer_string", ctypes.c_wchar_p),
    ("product_string", ctypes.c_wchar_p),
    ("usage_page", ctypes.c_ushort),
    ("usage", ctypes.c_ushort),
    ("interface_number", ctypes.c_int),
    ("next", ctypes.POINTER(HidDeviceInfo)),
]

HidDevice = ctypes.c_void_p


def load():
    dll = None
    for c in DLL_CANDIDATES:
        if os.path.exists(c):
            dll = c
            break
    if dll is None:
        raise FileNotFoundError("no hidapi.dll found; candidates: %s" % DLL_CANDIDATES)
    lib = ctypes.CDLL(dll)
    lib.hid_enumerate.restype = ctypes.POINTER(HidDeviceInfo)
    lib.hid_enumerate.argtypes = [ctypes.c_ushort, ctypes.c_ushort]
    lib.hid_open_path.restype = HidDevice
    lib.hid_open_path.argtypes = [ctypes.c_char_p]
    lib.hid_write.restype = ctypes.c_int
    lib.hid_write.argtypes = [HidDevice, ctypes.c_char_p, ctypes.c_size_t]
    lib.hid_read.restype = ctypes.c_int
    lib.hid_read.argtypes = [HidDevice, ctypes.c_char_p, ctypes.c_size_t]
    lib.hid_read_timeout.restype = ctypes.c_int
    lib.hid_read_timeout.argtypes = [HidDevice, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]
    lib.hid_set_nonblocking.restype = ctypes.c_int
    lib.hid_set_nonblocking.argtypes = [HidDevice, ctypes.c_int]
    lib.hid_error.restype = ctypes.c_wchar_p
    lib.hid_error.argtypes = [HidDevice]
    lib.hid_close.argtypes = [HidDevice]
    lib.hid_free_enumeration.argtypes = [ctypes.POINTER(HidDeviceInfo)]
    lib.hid_exit.restype = ctypes.c_int
    return lib


def enumerate_devices(lib, vids, pids):
    for vid in vids:
        for pid in pids:
            info = lib.hid_enumerate(vid, pid)
            cur = info
            while cur:
                if cur.contents.interface_number >= 0 and cur.contents.path:
                    # prefer entries with no interface collection (info[7]==NULL not exposed; return first)
                    return vid, pid, cur.contents.path
                cur = cur.contents.next
            if info:
                lib.hid_free_enumeration(info)
    return None


VIDS = [0x1189, 0x514C]
PIDS = [0x8842, 0x8840, 0x8830, 0x8831, 0x8832, 0x8833, 0x8850, 0x8851]


def open_device(lib=None):
    if lib is None:
        lib = load()
    res = enumerate_devices(lib, VIDS, PIDS)
    if res is None:
        raise RuntimeError("device not found")
    vid, pid, path = res
    dev = lib.hid_open_path(path)
    if not dev:
        raise RuntimeError("hid_open_path failed")
    return lib, dev, vid, pid


def handshake(lib, dev):
    req = bytearray(65)
    req[0] = 0x03
    req[1:4] = b"\xfb\xfb\xfb"
    lib.hid_write(dev, bytes(req), 65)
    resp = bytearray(64)
    n = lib.hid_read_timeout(dev, bytes(resp), 64, 10)
    if n < 0:
        raise RuntimeError(lib.hid_error(dev))
    version = struct.unpack_from("<H", resp, 6)[0]
    devtype = resp[8]
    return version, devtype, n


def write_report(lib, dev, payload_64):
    buf = bytearray(65)
    buf[0] = 0x03
    buf[1:65] = payload_64
    return lib.hid_write(dev, bytes(buf), 65)


def main():
    lib = load()
    lib2, dev, vid, pid = open_device(lib)
    print("opened VID=%04X PID=%04X" % (vid, pid))
    ver, dtype, n = handshake(lib2, dev)
    print("version=%d type=%d read=%d" % (ver, dtype, n))
    lib2.hid_close(dev)
    lib2.hid_exit()


if __name__ == "__main__":
    main()
