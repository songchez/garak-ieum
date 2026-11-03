// A console-subsystem entry point: never proxy, decode, or write MCP stdout.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <algorithm>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE handle = nullptr) noexcept : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};

struct Attributes {
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};

int fail(const char* message) noexcept {
  // Fixed diagnostics only: do not expose tokens, environment values, or submitted arguments.
  DWORD written = 0;
  const HANDLE output = GetStdHandle(STD_ERROR_HANDLE);
  WriteFile(output, "garak-mcp: ", 11, &written, nullptr);
  WriteFile(output, message, static_cast<DWORD>(std::strlen(message)), &written, nullptr);
  WriteFile(output, "\n", 1, &written, nullptr);
  return 1;
}

std::wstring quote(const std::wstring& argument) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t character : argument) {
    if (character == L'\\') { ++slashes; continue; }
    if (character == L'\"') result.append(slashes * 2 + 1, L'\\');
    else result.append(slashes, L'\\');
    result += character;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  result += L'\"';
  return result;
}

bool childEnvironment(std::vector<wchar_t>& result) {
  struct Environment {
    LPWCH value = GetEnvironmentStringsW();
    ~Environment() { if (value) FreeEnvironmentStringsW(value); }
  } environment;
  if (!environment.value) return false;
  std::vector<std::wstring> entries;
  for (const wchar_t* cursor = environment.value; *cursor; cursor += std::wcslen(cursor) + 1) {
    const std::wstring entry(cursor);
    const std::wstring name = entry.substr(0, entry.find(L'=', 1)); // Preserve hidden drive entries such as =C:.
    // Keep GARAK_MCP_* and normal user settings, but do not inherit alternate Node entry loaders.
    if (_wcsicmp(name.c_str(), L"ELECTRON_RUN_AS_NODE") == 0 || _wcsicmp(name.c_str(), L"ELECTRON_NO_ASAR") == 0 ||
        _wcsicmp(name.c_str(), L"NODE_OPTIONS") == 0 || _wcsicmp(name.c_str(), L"NODE_PATH") == 0) continue;
    entries.push_back(entry);
  }
  entries.emplace_back(L"ELECTRON_RUN_AS_NODE=1");
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_LESS_THAN;
  });
  for (const auto& entry : entries) {
    result.insert(result.end(), entry.begin(), entry.end());
    result.push_back(L'\0');
  }
  result.push_back(L'\0'); // CreateProcessW requires a double-NUL terminated Unicode block.
  return true;
}

bool fileExists(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

int run(int argc, wchar_t** argv) {
  const bool token = argc == 2 && std::wcscmp(argv[1], L"--mcp-token") == 0;
  if (argc > 2 || (argc == 2 && !token && std::wcscmp(argv[1], L"--mcp") != 0)) {
    fail("Usage: garak-mcp.exe [--mcp | --mcp-token]");
    return 2;
  }

  std::wstring location(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, location.data(), static_cast<DWORD>(location.size()));
  if (!length || length >= location.size()) return fail("Cannot locate the installed launcher.");
  location.resize(length);
  const size_t separator = location.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return fail("Cannot locate the application directory.");
  const std::wstring directory = location.substr(0, separator + 1);
  const std::wstring executable = directory + L"가락이음.exe";
  const std::wstring archive = directory + L"resources\\app.asar";
  if (!fileExists(executable) || !fileExists(archive)) return fail("Application files are missing. Reinstall Garak Ieum.");
  const std::wstring script = archive + L"\\dist-mcp\\mcp\\" + (token ? L"token.js" : L"server.js");
  std::wstring command = quote(executable) + L" " + quote(script);
  if (command.size() >= 32767) return fail("The installation path is too long.");
  std::vector<wchar_t> environment;
  if (!childEnvironment(environment)) return fail("Cannot prepare the child environment.");

  Handle streams[3];
  HANDLE inherited[3]{};
  const DWORD identifiers[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (size_t index = 0; index < 3; ++index) {
    const HANDLE source = GetStdHandle(identifiers[index]);
    if (!source || source == INVALID_HANDLE_VALUE ||
        !DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &streams[index].value, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
      return fail("Cannot inherit the MCP standard streams.");
    }
    inherited[index] = streams[index].value;
  }

  Handle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, static_cast<DWORD>(sizeof(limits)))) {
    return fail("Cannot create the child cleanup job.");
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  if (!size) return fail("Cannot prepare process attributes.");
  std::vector<unsigned char> storage(size);
  Attributes attributes;
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(list, 2, 0, &size)) return fail("Cannot initialize process attributes.");
  attributes.value = list;
  // Only the three stream duplicates are inherited; the job handle remains owned by this launcher.
  // Windows 10+ assigns the job before the child runs, avoiding a suspended-process cleanup race.
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(job.value), nullptr, nullptr)) {
    return fail("Cannot configure child stream inheritance and cleanup.");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  startup.lpAttributeList = list;
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment.data(), directory.c_str(), &startup.StartupInfo, &child)) {
    return fail("Cannot start the bundled MCP runtime.");
  }
  Handle process(child.hProcess);
  Handle thread(child.hThread);
  if (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) return fail("Cannot wait for the MCP runtime.");
  DWORD exitCode = 1;
  if (!GetExitCodeProcess(process.value, &exitCode)) return fail("Cannot read the MCP runtime exit status.");
  return static_cast<int>(exitCode);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  try { return run(argc, argv); }
  catch (...) { return fail("Cannot initialize the MCP launcher."); }
}
