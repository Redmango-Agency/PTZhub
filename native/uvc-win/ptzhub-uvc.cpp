// ptzhub-uvc.exe — comandi pan, tilt, zoom e fuoco per le camere USB (UVC) su Windows,
// SENZA aprire il video: usa IAMCameraControl di DirectShow, la stessa interfaccia della scheda
// «Controllo telecamera» di OBS. Così la camera resta libera per OBS o Zoom, anche su Windows 10.
//
// Protocollo (una riga per richiesta su stdin, una riga JSON per risposta su stdout):
//   <id>\tlist                         -> {"id":n,"ok":true,"value":[{"name","path","caps"}]}
//   <id>\topen\t<nome>\t<vid_xxxx&pid_yyyy>
//                                      -> {"id":n,"ok":true,"value":{"label","path","caps","settings"}}
//   <id>\tset\tpan=1\ttilt=2\tzoom=3\tfocusDistance=4\tfocusMode=manual|continuous
//                                      -> {"id":n,"ok":true,"value":{settings}}
//   <id>\tget                          -> {"id":n,"ok":true,"value":{settings}}
//   <id>\trelcaps                      -> {"id":n,"ok":true,"value":{"pan":{min,max,step},"tilt":{...}}}
//      comandi «a velocità» (KSPROPERTY_CAMERACONTROL_PAN/TILT_RELATIVE): solo gli assi che la
//      camera accetta; oggetto vuoto se nessuno
//   <id>\trel\tpan=2\ttilt=-1          -> {"id":n,"ok":true,"value":null}
//      la camera si muove alla velocità data (segno = verso, 0 = ferma) finché non arriva lo 0.
//      Sicurezza: se per 1,5 s non arriva un nuovo «rel», l'aiuto la ferma da solo; la ferma anche
//      quando PTZ Hub si chiude (fine dello stdin)
//   <id>\tclose                        -> {"id":n,"ok":true,"value":null}
// Errori: {"id":n,"ok":false,"name":"NotFoundError|NotReadableError|Error","message":"..."}
//
// Compilazione: node scripts/build-uvc-helper.js (mingw-w64)

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dshow.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {

// KSPROPERTY_CAMERACONTROL_PAN_RELATIVE / TILT_RELATIVE (ksmedia.h): IAMCameraControl li passa al
// driver come gli altri numeri di proprietà
const long kRelIds[2] = {10, 11};
const char* const kRelNames[2] = {"pan", "tilt"};
const ULONGLONG kRelWatchdogMs = 1500;

CRITICAL_SECTION g_lock;          // un solo comando alla volta verso la camera (stdin e controllo)
IAMCameraControl* g_relCc = nullptr;  // camera aperta, per il controllo di sicurezza
long g_relVal[2] = {0, 0};
ULONGLONG g_relAt = 0;

bool relMoving() { return g_relVal[0] != 0 || g_relVal[1] != 0; }

// ferma il movimento a velocità (da chiamare con g_lock preso)
void relStopLocked() {
  if (g_relCc) {
    for (int i = 0; i < 2; i++) {
      if (g_relVal[i]) g_relCc->Set(kRelIds[i], 0, CameraControl_Flags_Manual);
    }
  }
  g_relVal[0] = g_relVal[1] = 0;
}

// controllo di sicurezza: se PTZ Hub smette di confermare il movimento, la camera si ferma
DWORD WINAPI relWatchdog(LPVOID) {
  for (;;) {
    Sleep(100);
    EnterCriticalSection(&g_lock);
    if (relMoving() && GetTickCount64() - g_relAt > kRelWatchdogMs) relStopLocked();
    LeaveCriticalSection(&g_lock);
  }
  return 0;
}

struct Locked {
  Locked() { EnterCriticalSection(&g_lock); }
  ~Locked() { LeaveCriticalSection(&g_lock); }
};

std::string utf8(const wchar_t* w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return "";
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

std::string lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string jsonStr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else {
          o += static_cast<char>(c);
        }
    }
  }
  return o + "\"";
}

std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); i++) {
    if (i == s.size() || s[i] == sep) {
      out.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return out;
}

struct Device {
  std::string name;
  std::string path;
  IMoniker* moniker = nullptr;
};

void releaseAll(std::vector<Device>& list) {
  for (auto& d : list) {
    if (d.moniker) d.moniker->Release();
    d.moniker = nullptr;
  }
  list.clear();
}

std::vector<Device> listDevices() {
  std::vector<Device> out;
  ICreateDevEnum* devEnum = nullptr;
  if (FAILED(CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER, IID_ICreateDevEnum,
                              reinterpret_cast<void**>(&devEnum)))) {
    return out;
  }
  IEnumMoniker* enumMon = nullptr;
  HRESULT hr = devEnum->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &enumMon, 0);
  if (hr == S_OK && enumMon) {
    IMoniker* mon = nullptr;
    while (enumMon->Next(1, &mon, nullptr) == S_OK) {
      Device d;
      d.moniker = mon;
      IPropertyBag* bag = nullptr;
      if (SUCCEEDED(mon->BindToStorage(nullptr, nullptr, IID_IPropertyBag, reinterpret_cast<void**>(&bag)))) {
        VARIANT v;
        VariantInit(&v);
        if (SUCCEEDED(bag->Read(L"FriendlyName", &v, nullptr)) && v.vt == VT_BSTR) d.name = utf8(v.bstrVal);
        VariantClear(&v);
        if (SUCCEEDED(bag->Read(L"DevicePath", &v, nullptr)) && v.vt == VT_BSTR) d.path = utf8(v.bstrVal);
        VariantClear(&v);
        bag->Release();
      }
      out.push_back(d);
    }
    enumMon->Release();
  }
  devEnum->Release();
  return out;
}

// HRESULT -> nome dell'errore come in Chromium, così il programma lo spiega allo stesso modo
const char* errorName(HRESULT hr) {
  switch (static_cast<unsigned long>(hr)) {
    case 0x8007048FUL:  // ERROR_DEVICE_NOT_CONNECTED
    case 0x80070651UL:  // ERROR_DEVICE_REMOVED
    case 0x80070002UL:  // ERROR_FILE_NOT_FOUND
    case 0x80070015UL:  // ERROR_NOT_READY
    case 0x8007001FUL:  // ERROR_GEN_FAILURE (camera staccata durante il comando)
      return "NotFoundError";
    case 0x80070005UL:  // E_ACCESSDENIED
    case 0x80070020UL:  // ERROR_SHARING_VIOLATION
    case 0x800700AAUL:  // ERROR_BUSY
      return "NotReadableError";
    default:
      return "Error";
  }
}

std::string hrText(HRESULT hr) {
  char b[32];
  snprintf(b, sizeof b, "0x%08lX", static_cast<unsigned long>(hr));
  return b;
}

struct Axis {
  bool ok = false;
  long min = 0, max = 0, step = 0, def = 0, flags = 0;
};

Axis axisRange(IAMCameraControl* cc, long prop) {
  Axis a;
  if (!cc) return a;
  if (SUCCEEDED(cc->GetRange(prop, &a.min, &a.max, &a.step, &a.def, &a.flags)) && a.max > a.min &&
      (a.flags & CameraControl_Flags_Manual)) {
    a.ok = true;
  }
  return a;
}

std::string rangeJson(const Axis& a) {
  return "{\"min\":" + std::to_string(a.min) + ",\"max\":" + std::to_string(a.max) +
         ",\"step\":" + std::to_string(a.step > 0 ? a.step : 1) + "}";
}

// capacità nello stesso formato di MediaStreamTrack.getCapabilities()
std::string capsJson(IAMCameraControl* cc) {
  if (!cc) return "{}";
  std::string o = "{";
  bool first = true;
  auto add = [&](const std::string& kv) {
    if (!first) o += ",";
    o += kv;
    first = false;
  };
  Axis pan = axisRange(cc, CameraControl_Pan);
  Axis tilt = axisRange(cc, CameraControl_Tilt);
  Axis zoom = axisRange(cc, CameraControl_Zoom);
  Axis focus = axisRange(cc, CameraControl_Focus);
  if (pan.ok) add("\"pan\":" + rangeJson(pan));
  if (tilt.ok) add("\"tilt\":" + rangeJson(tilt));
  if (zoom.ok) add("\"zoom\":" + rangeJson(zoom));
  if (focus.ok) {
    add("\"focusDistance\":" + rangeJson(focus));
    std::string modes = "[\"manual\"";
    if (focus.flags & CameraControl_Flags_Auto) modes += ",\"continuous\"";
    add("\"focusMode\":" + modes + "]");
  }
  return o + "}";
}

std::string settingsJson(IAMCameraControl* cc) {
  if (!cc) return "{}";
  std::string o = "{";
  bool first = true;
  auto add = [&](const std::string& kv) {
    if (!first) o += ",";
    o += kv;
    first = false;
  };
  const struct { long prop; const char* key; } props[] = {
      {CameraControl_Pan, "pan"}, {CameraControl_Tilt, "tilt"}, {CameraControl_Zoom, "zoom"}};
  for (const auto& p : props) {
    long v = 0, f = 0;
    if (SUCCEEDED(cc->Get(p.prop, &v, &f))) add("\"" + std::string(p.key) + "\":" + std::to_string(v));
  }
  long v = 0, f = 0;
  if (SUCCEEDED(cc->Get(CameraControl_Focus, &v, &f))) {
    add("\"focusDistance\":" + std::to_string(v));
    add(std::string("\"focusMode\":") + ((f & CameraControl_Flags_Auto) ? "\"continuous\"" : "\"manual\""));
  }
  return o + "}";
}

class Camera {
 public:
  ~Camera() { close(); }

  void close() {
    if (cc_) cc_->Release();
    if (filter_) filter_->Release();
    cc_ = nullptr;
    filter_ = nullptr;
    name_.clear();
    path_.clear();
  }

  // Cerca la camera: prima per VID/PID nel percorso del dispositivo, poi per nome
  HRESULT open(const std::string& name, const std::string& vidpid) {
    close();
    std::vector<Device> list = listDevices();
    const Device* pick = nullptr;
    const std::string want = lower(name);
    const std::string vp = lower(vidpid);
    if (!vp.empty()) {
      for (const auto& d : list) {
        if (lower(d.path).find(vp) == std::string::npos) continue;
        if (!pick || lower(d.name) == want) pick = &d;
      }
    }
    if (!pick && !want.empty()) {
      for (const auto& d : list) if (lower(d.name) == want) { pick = &d; break; }
    }
    if (!pick && !want.empty()) {
      for (const auto& d : list) {
        const std::string n = lower(d.name);
        if (n.find(want) != std::string::npos || want.find(n) != std::string::npos) { pick = &d; break; }
      }
    }
    if (!pick) {
      releaseAll(list);
      return HRESULT_FROM_WIN32(ERROR_DEVICE_NOT_CONNECTED);
    }
    HRESULT hr = pick->moniker->BindToObject(nullptr, nullptr, IID_IBaseFilter, reinterpret_cast<void**>(&filter_));
    if (SUCCEEDED(hr)) {
      // senza IAMCameraControl la camera non ha comandi via USB: si risponde con capacità vuote
      if (FAILED(filter_->QueryInterface(IID_IAMCameraControl, reinterpret_cast<void**>(&cc_)))) cc_ = nullptr;
      name_ = pick->name;
      path_ = pick->path;
    }
    releaseAll(list);
    return hr;
  }

  bool isOpen() const { return filter_ != nullptr; }
  IAMCameraControl* cc() const { return cc_; }
  const std::string& name() const { return name_; }
  const std::string& path() const { return path_; }

 private:
  IBaseFilter* filter_ = nullptr;
  IAMCameraControl* cc_ = nullptr;
  std::string name_;
  std::string path_;
};

void reply(const std::string& id, const std::string& value) {
  std::string line = "{\"id\":" + id + ",\"ok\":true,\"value\":" + value + "}\n";
  fwrite(line.data(), 1, line.size(), stdout);
  fflush(stdout);
}

void fail(const std::string& id, const char* name, const std::string& message) {
  std::string line = "{\"id\":" + id + ",\"ok\":false,\"name\":" + jsonStr(name) + ",\"message\":" + jsonStr(message) + "}\n";
  fwrite(line.data(), 1, line.size(), stdout);
  fflush(stdout);
}

bool isNumber(const std::string& s) {
  if (s.empty() || s.size() > 12) return false;
  for (char c : s) if (c < '0' || c > '9') return false;
  return true;
}

}  // namespace

int main() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    fprintf(stderr, "COM non disponibile\n");
    return 1;
  }
  Camera cam;
  InitializeCriticalSection(&g_lock);
  CreateThread(nullptr, 0, relWatchdog, nullptr, 0, nullptr);
  std::string line;
  while (std::getline(std::cin, line)) {
    Locked guard;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const std::vector<std::string> p = split(line, '\t');
    if (p.size() < 2 || !isNumber(p[0])) continue;
    const std::string& id = p[0];
    const std::string& cmd = p[1];

    if (cmd == "list") {
      std::vector<Device> list = listDevices();
      std::string o = "[";
      for (size_t i = 0; i < list.size(); i++) {
        IBaseFilter* f = nullptr;
        IAMCameraControl* cc = nullptr;
        if (SUCCEEDED(list[i].moniker->BindToObject(nullptr, nullptr, IID_IBaseFilter, reinterpret_cast<void**>(&f)))) {
          if (FAILED(f->QueryInterface(IID_IAMCameraControl, reinterpret_cast<void**>(&cc)))) cc = nullptr;
        }
        if (i) o += ",";
        o += "{\"name\":" + jsonStr(list[i].name) + ",\"path\":" + jsonStr(list[i].path) + ",\"caps\":" + capsJson(cc) + "}";
        if (cc) cc->Release();
        if (f) f->Release();
      }
      releaseAll(list);
      reply(id, o + "]");
    } else if (cmd == "open") {
      const std::string name = p.size() > 2 ? p[2] : "";
      const std::string vidpid = p.size() > 3 ? p[3] : "";
      relStopLocked();
      g_relCc = nullptr;
      HRESULT hr = cam.open(name, vidpid);
      g_relCc = cam.cc();
      if (FAILED(hr)) {
        fail(id, errorName(hr), "camera USB non trovata o non apribile (" + hrText(hr) + ")");
        continue;
      }
      reply(id, "{\"label\":" + jsonStr(cam.name()) + ",\"path\":" + jsonStr(cam.path()) +
                    ",\"caps\":" + capsJson(cam.cc()) + ",\"settings\":" + settingsJson(cam.cc()) + "}");
    } else if (cmd == "set" || cmd == "get") {
      if (!cam.isOpen()) {
        fail(id, "InvalidStateError", "nessuna camera USB aperta");
        continue;
      }
      IAMCameraControl* cc = cam.cc();
      HRESULT bad = S_OK;
      if (cmd == "set" && cc) {
        for (size_t i = 2; i < p.size(); i++) {
          const size_t eq = p[i].find('=');
          if (eq == std::string::npos) continue;
          const std::string k = p[i].substr(0, eq);
          const std::string v = p[i].substr(eq + 1);
          HRESULT hr = S_OK;
          if (k == "focusMode") {
            long cur = 0, f = 0;
            cc->Get(CameraControl_Focus, &cur, &f);
            hr = cc->Set(CameraControl_Focus, cur, v == "manual" ? CameraControl_Flags_Manual : CameraControl_Flags_Auto);
          } else {
            long prop = -1;
            if (k == "pan") prop = CameraControl_Pan;
            else if (k == "tilt") prop = CameraControl_Tilt;
            else if (k == "zoom") prop = CameraControl_Zoom;
            else if (k == "focusDistance") prop = CameraControl_Focus;
            if (prop < 0) continue;
            const double d = strtod(v.c_str(), nullptr);
            if (!std::isfinite(d)) continue;
            hr = cc->Set(prop, static_cast<long>(std::lround(d)), CameraControl_Flags_Manual);
          }
          if (FAILED(hr) && SUCCEEDED(bad)) bad = hr;
        }
      }
      // camera staccata o comando rifiutato: si dice subito (staccata = il programma la ricollega)
      if (FAILED(bad)) {
        const char* n = errorName(bad);
        fail(id, n, std::string(n) == "NotFoundError" ? "camera USB scollegata (" + hrText(bad) + ")"
                                                      : "comando USB rifiutato dalla camera (" + hrText(bad) + ")");
        continue;
      }
      reply(id, settingsJson(cc));
    } else if (cmd == "relcaps") {
      if (!cam.isOpen() || !cam.cc()) {
        fail(id, "InvalidStateError", "nessuna camera USB aperta");
        continue;
      }
      std::string o = "{";
      bool first = true;
      for (int i = 0; i < 2; i++) {
        long mn = 0, mx = 0, st = 0, df = 0, fl = 0;
        if (FAILED(cam.cc()->GetRange(kRelIds[i], &mn, &mx, &st, &df, &fl))) continue;
        if (mn == 0 && mx == 0) continue;
        if (!first) o += ",";
        first = false;
        o += "\"" + std::string(kRelNames[i]) + "\":{\"min\":" + std::to_string(mn) + ",\"max\":" +
             std::to_string(mx) + ",\"step\":" + std::to_string(st) + "}";
      }
      reply(id, o + "}");
    } else if (cmd == "rel") {
      if (!cam.isOpen() || !cam.cc()) {
        fail(id, "InvalidStateError", "nessuna camera USB aperta");
        continue;
      }
      HRESULT bad = S_OK;
      for (size_t i = 2; i < p.size(); i++) {
        const size_t eq = p[i].find('=');
        if (eq == std::string::npos) continue;
        const std::string k = p[i].substr(0, eq);
        const double d = strtod(p[i].substr(eq + 1).c_str(), nullptr);
        if (!std::isfinite(d)) continue;
        for (int a = 0; a < 2; a++) {
          if (k != kRelNames[a]) continue;
          const long v = static_cast<long>(std::lround(d));
          HRESULT hr = cam.cc()->Set(kRelIds[a], v, CameraControl_Flags_Manual);
          if (SUCCEEDED(hr)) g_relVal[a] = v;
          else if (SUCCEEDED(bad)) bad = hr;
        }
      }
      g_relAt = GetTickCount64();
      if (FAILED(bad)) {
        relStopLocked();
        fail(id, errorName(bad), "comando a velocità rifiutato dalla camera (" + hrText(bad) + ")");
        continue;
      }
      reply(id, "null");
    } else if (cmd == "close") {
      relStopLocked();
      g_relCc = nullptr;
      cam.close();
      reply(id, "null");
    } else {
      fail(id, "TypeError", "comando sconosciuto: " + cmd);
    }
  }
  {
    // PTZ Hub chiuso (fine dello stdin): la camera non deve restare in movimento
    Locked guard;
    relStopLocked();
    g_relCc = nullptr;
    cam.close();
  }
  CoUninitialize();
  return 0;
}
