# Integrate react-native-lego-api-logger — Skill

When the user says **"integrate api logger"**, **"add lego api logger"**, **"wire up react-native-lego-api-logger"**, or asks to add this plugin to a React Native project, follow this rule end-to-end.

The plugin lives at `github:cashify/react-native-lego-api-logger`. It exposes:

- `LegoApiLogger.start(options?)` — apply filters + enable in one call (defaults to Cashify API hosts).
- `LegoApiLogger.stop()` — disable capture.
- `LegoApiLogger.subscribe(cb)` / `getLogs()` / `clearLogs()` / `setFilters({...})` — primitives.
- `<ApiLoggerScreen navigation={...} />` — debug UI screen.

This integration touches **JS, Android (Kotlin), and iOS (Swift)** — do all three in one pass.

---

## Step 0 — Preconditions (ask if unclear)

Before any edits, verify the target project meets these requirements. If anything is missing or ambiguous, stop and ask.

| Check | How to verify | If false |
|---|---|---|
| Is React Native ≥ 0.70 | Read `package.json` → `dependencies."react-native"` | Stop. Plugin requires modern RN. |
| Has `react-native-safe-area-context` | Read `package.json` → check dep | Add it: `"react-native-safe-area-context": "^4.0.0"` |
| Has `@react-native-clipboard/clipboard` | Read `package.json` → check dep | Add it: `"@react-native-clipboard/clipboard": "^1.11.0"` |
| iOS AppDelegate is Swift | Look for `ios/<AppName>/AppDelegate.swift` | Stop. This skill only handles Swift AppDelegate. Ask the user. |
| Android `MainApplication.kt` exists | Look for `android/app/src/main/.../MainApplication.kt` | Stop. Plugin requires Kotlin MainApplication, not Java. Ask. |
| `@reglobe/lego-core` is a dependency | Read `package.json` → `dependencies."@reglobe/lego-core"` | If present, **Step 1.5 is mandatory** — add the autolinking exclusion before running any install. |

Ask the user these questions BEFORE editing (use AskUserQuestion if available):

1. **Plugin version**: Which Git tag to install? Default: `v0.1.0`. (Format: `github:cashify/react-native-lego-api-logger#vX.Y.Z`.)
2. **Env gating**: Should logging be gated on an env flag (e.g. `Config.ENABLE_API_LOGGER === 'true'`) or always-on? If gated, what is the env var name?
3. **App entry**: What is the JS entry file where `LegoApiLogger.start()` should be called? Default: `App.tsx` or `src/App.tsx`. Inside which lifecycle hook? Default: a top-level `useEffect(() => { ... }, [])` at app boot.
4. **Navigator**: Are you using React Navigation native-stack? If yes, what's the stack file path and what name should the route have? Default route name: `ApiLogger`. (If a different navigator is used — drawer, tab, or custom — skip Step 5 and inform the user to register the screen manually.)
5. **iOS bundle ID guard**: Does the project want the URLProtocol active in production builds too, or DEBUG only? Default: DEBUG only, gated via `#if DEBUG`.

---

## Step 1 — Add dependency

Edit the target project's root `package.json`. Add inside `"dependencies"`:

```jsonc
"react-native-lego-api-logger": "github:cashify/react-native-lego-api-logger#v0.1.0"
```

Also verify `"react-native-safe-area-context": "^4.0.0"` (or later) is present. If missing, add it.

Also verify `"@react-native-clipboard/clipboard": "^1.11.0"` (or later) is present. If missing, add it. The debug screen imports it directly for its per-section Copy actions, so the screen will throw at import time if it is absent. It is a native module, so adding it requires a pod install and a rebuild (Step 6).

**Do NOT add `"codegenConfig"` anywhere referencing this plugin.** It is a legacy paper module — codegen will break the build (`react_codegen_RNLegoApiLogger` CMake target missing).

---

## Step 1.5 — Exclude `@reglobe/lego-core` from autolinking (MANDATORY if present)

Most Cashify projects depend on `@reglobe/lego-core` (used for `LegoServiceURL`, hooks, etc.). The package is **JS-only** but ships an `android/` folder (unrelated example app), so RN CLI autolinking on both platforms (`settings.gradle`'s `autolinkLibrariesFromCommand()`, Podfile's `use_native_modules!`) tries to treat it as a native module and fails.

Check first:

```bash
grep -l '"@reglobe/lego-core"' package.json
```

If the result is non-empty, set up the fix below **before** Step 6's install commands.

### Why a root `react-native.config.js` exclusion does NOT work

Adding `dependencies: { '@reglobe/lego-core': { platforms: { android: null, ios: null } } }` to the project root `react-native.config.js` is the documented RN CLI pattern, but **does not reliably override** `@reglobe/lego-core`'s package-level autolinking metadata. RN CLI still attempts to link it. Do not waste time on this approach.

### Working fix — per-package config written via postinstall

The `@reglobe/lego-core` package itself needs to ship a `react-native.config.js` declaring it has no platforms. Since we can't patch the upstream package, write it into `node_modules/` after every install via a postinstall script.

#### 1. Create / update the postinstall script

Look for an existing `scripts/postinstall.js` in the target project. If one exists, **append** the lego-core fix block to it (don't overwrite). If not, create it at `scripts/postinstall.js`:

```js
const fs = require('fs');
const path = require('path');

const target = path.resolve(
  __dirname,
  '../node_modules/@reglobe/lego-core/react-native.config.js',
);

const content = `module.exports = {
  dependency: {
    platforms: {
      android: null,
      ios: null,
    },
  },
};
`;

try {
  if (fs.existsSync(path.dirname(target))) {
    fs.writeFileSync(target, content, 'utf8');
  }
} catch (_) {}
```

> Note the `dependency:` (singular) key — this is the RN CLI **per-package config** form, where a package declares its own platform-linking status. This is different from the `dependencies:` (plural) form used in a project root `react-native.config.js` to override a specific dep, and only the singular per-package form reliably suppresses autolinking for `@reglobe/lego-core`.

#### 2. Wire it into `package.json`

Add (or extend) the `postinstall` script in the target project's `package.json`:

```jsonc
"scripts": {
  // ... existing scripts ...
  "postinstall": "node scripts/postinstall.js"
}
```

If a `postinstall` already exists (e.g. `"patch-package"`), chain it:

```jsonc
"postinstall": "node scripts/postinstall.js && patch-package"
```

#### 3. Run the install to apply

```bash
yarn install
# verify the file landed:
cat node_modules/@reglobe/lego-core/react-native.config.js
# should print the dependency: { platforms: { android: null, ios: null } } block
```

If you skipped Step 6's cache clear before realizing this, run it again now:

```bash
rm -rf android/app/build/generated/autolinking android/app/.cxx
```

---

## Step 2 — Wire iOS (Swift AppDelegate)

Find the Swift AppDelegate (typically `ios/<AppName>/AppDelegate.swift`).

### 2a. Add the import

Add after the other `import` lines at the top of the file:

```swift
import LegoApiLogger
```

> The module name `LegoApiLogger` comes from the plugin's podspec (`s.module_name`). Do NOT use `react_native_lego_api_logger` or any other name.

### 2b. Hook the URLProtocol into RN's networking

Inside `application(_:didFinishLaunchingWithOptions:)`, **before** `RCTReactNativeFactory` / `startReactNative` is invoked, insert:

```swift
RCTSetCustomNSURLSessionConfigurationProvider {
  LegoAPILoggerModule.configurationWithProtocol()
}
```

If the user opted for DEBUG-only iOS interception (Step 0, question 5), wrap it:

```swift
#if DEBUG
RCTSetCustomNSURLSessionConfigurationProvider {
  LegoAPILoggerModule.configurationWithProtocol()
}
#endif
```

> Calling `LegoApiLogger.enable()` from JS alone is **not sufficient** on iOS. `URLProtocol.registerClass()` does not intercept RN's `RCTHTTPRequestHandler` because RN builds its own `URLSessionConfiguration`. The `RCTSetCustomNSURLSessionConfigurationProvider` callback is the only supported hook.

### 2c. Remove any pre-existing AppDelegate helpers that built a custom session config

If the project already has a `customSessionConfiguration()` or similar method inserting some other URLProtocol, the user must consolidate manually. Flag it and ask before editing.

---

## Step 3 — Wire Android (MainApplication.kt)

Find `MainApplication.kt` (typically `android/app/src/main/java/<package-path>/MainApplication.kt` or under `kotlin/`).

### 3a. Add the imports

Add after existing imports:

```kotlin
import com.facebook.react.modules.network.OkHttpClientProvider
import com.legoapilogger.LegoAPILoggerInterceptor
import com.legoapilogger.LegoTimingEventListener
```

> The package name `com.legoapilogger` is the plugin's neutral Kotlin package. **Do NOT** add `import com.legoapilogger.LegoAPILoggerPackage` and **do NOT** call `add(LegoAPILoggerPackage())` — autolinking registers it automatically. Manually adding it again causes a duplicate-module runtime error.

### 3b. Add the OkHttp interceptor

Add a private method to the `MainApplication` class:

```kotlin
private fun initHttpClient() {
    val builder = OkHttpClientProvider.createClientBuilder(this)
    builder.addInterceptor(LegoAPILoggerInterceptor())
    builder.eventListenerFactory(LegoTimingEventListener.Factory())
    val okHttpClient = builder.build()
    OkHttpClientProvider.setOkHttpClientFactory { okHttpClient }
}
```

Call it from `onCreate()`, **before** `loadReactNative(this)` (or whichever bootstrap call the project uses — `SoLoader.init`, `ReactNativeHost.create`, etc.):

```kotlin
override fun onCreate() {
    super.onCreate()
    initHttpClient()              // <-- add this line
    // ... existing init calls ...
    loadReactNative(this)         // or equivalent
}
```

If a project already has an `OkHttpClientProvider.setOkHttpClientFactory` block (e.g. for Flipper, certificate pinning, or another interceptor), **merge** the `addInterceptor` and `eventListenerFactory` calls into the existing builder. Do NOT replace.

### 3c. Verify no duplicate `LegoAPILoggerPackage` registration

Grep `MainApplication.kt` for `LegoAPILoggerPackage`. If found, **remove that line** — autolinking handles it.

---

## Step 4 — Add `LegoApiLogger.start()` to JS entry

Edit the project's app entry file (asked in Step 0).

### 4a. Add the import

```ts
import { LegoApiLogger } from 'react-native-lego-api-logger';
```

### 4b. Add the lifecycle call

Inside a top-level `useEffect(() => { ... }, [])` (or whatever pattern the project uses for one-time boot setup), add:

```ts
// Always-on variant
LegoApiLogger.start();
```

Or, if env-gated (asked in Step 0):

```ts
import Config from 'react-native-config';

const apiLoggerEnabled =
  (Config as { ENABLE_API_LOGGER?: string }).ENABLE_API_LOGGER?.trim().toLowerCase() === 'true';

if (apiLoggerEnabled) {
  LegoApiLogger.start();
} else {
  LegoApiLogger.stop();
}
```

> `start()` applies the default Cashify domain filters (`*.api.cashify.in`, `*.api.beta.cashify.in`, `*.api.stage.cashify.in`) and enables logging in one call. To customize filters, pass `{ domainPatterns: ['*.api.example.com'], pathPatterns: ['^/api/.*'] }`. To skip the defaults entirely, pass `{ skipDefaultDomains: true, domainPatterns: [...] }`.

---

## Step 5 — Register the debug screen (React Navigation only)

Only run this step if the user confirmed React Navigation native-stack in Step 0. Otherwise, skip and tell the user how to render the screen manually:

```tsx
// Standalone usage example:
<ApiLoggerScreen navigation={{ goBack: () => closeModal() }} />
```

For React Navigation:

### 5a. Add the import

In the navigator file, add:

```ts
import { ApiLoggerScreen } from 'react-native-lego-api-logger';
```

### 5b. Add the route to RootStackParamList (if it exists)

If the project has a typed param list:

```ts
type RootStackParamList = {
  // ... existing routes
  ApiLogger: undefined;
};
```

If the project has a centralized `Routes` constant object:

```ts
export const Routes = {
  // ... existing
  API_LOGGER: 'ApiLogger',
} as const;
```

### 5c. Register the screen

Inside the `Stack.Navigator`:

```tsx
<Stack.Screen name="ApiLogger" component={ApiLoggerScreen} />
```

If the project uses `Routes.API_LOGGER` constant:

```tsx
<Stack.Screen name={Routes.API_LOGGER} component={ApiLoggerScreen} />
```

> The screen accepts navigation that has a `goBack()` method — fully compatible with React Navigation. No additional props required.

### 5d. (Optional) Add a debug entry-point button

This step is **optional** and only if the user wants a discoverable way to open the screen. If they didn't ask, skip — they may invoke the screen via a debug menu, a shake gesture, or some existing pattern.

If they want an entry point, the simplest pattern is a tiny pressable on the app's `Header` component, gated on the env flag:

```tsx
import { useNavigation } from '@react-navigation/native';

const isApiLoggerEnabled =
  Config.ENABLE_API_LOGGER?.trim().toLowerCase() === 'true';

// inside Header render:
{isApiLoggerEnabled ? (
  <Pressable onPress={() => navigation.navigate('ApiLogger')} hitSlop={12}>
    <Text style={{fontSize: 20, opacity: 0.7}}>ⓘ</Text>
  </Pressable>
) : null}
```

Adapt to the project's existing header / topbar component. If the project has no central header, ask where to place the entry.

---

## Step 6 — Install and rebuild

After all file edits are done, run these from the project root:

```bash
# 1. Re-install JS deps so the plugin is pulled in
yarn install

# 2. Refresh iOS Pods (autolinking + Swift module compilation)
cd ios && pod install && cd ..

# 3. Clear Android autolinking + CMake cache (prevents stale codegen state)
rm -rf android/app/build/generated/autolinking android/app/.cxx

# 4. Clean Android build (optional but recommended after native module changes)
cd android && ./gradlew clean && cd ..
```

If the project uses npm instead of yarn, swap `yarn install` for `npm install`. If pnpm — `pnpm install`.

> The plugin uses RN autolinking. There are no manual `Podfile` edits or `settings.gradle` includes required.

> If `@react-native-clipboard/clipboard` was added in Step 1, these same steps link it — it is a native module, so a JS reload alone is not enough. A full rebuild is required or the debug screen will fail to import.

---

## Step 7 — Verify

Run a debug build on both platforms and confirm:

| Check | How |
|---|---|
| Android compiles | `cd android && ./gradlew assembleDebug` — succeeds |
| iOS compiles | Open Xcode workspace, build for simulator — succeeds |
| JS bundles | Metro starts, no "Cannot find module 'react-native-lego-api-logger'" |
| Runtime: enabled flag | Add a temp `console.log('isLegoApiLoggerAvailable', isLegoApiLoggerAvailable())` at boot — should print `true` |
| Runtime: capture | Make an API call to a host matching the filters, navigate to the logger screen, see the request listed |

Tell the user:

> Test by making API calls in the app. To inspect logs, navigate to `ApiLogger` (or invoke `<ApiLoggerScreen />` directly). Use `LegoApiLogger.setFilters({...})` to narrow capture if logs are too noisy.

---

## Common Failures and Fixes

| Failure | Cause | Fix |
|---|---|---|
| `CMake Error … react_codegen_RNLegoApiLogger … not built` | `codegenConfig` declared in the plugin's or host's package.json | Remove `codegenConfig` referencing this plugin. Then `rm -rf android/app/build/generated/autolinking android/app/.cxx`. |
| Autolinking fails on `@reglobe/lego-core` (Android: `autolinkLibrariesFromCommand()` error in `settings.gradle`; iOS: `use_native_modules!` failure in Podfile) | RN CLI treats `lego-core`'s `android/` folder as a native module, but it's JS-only. Root `react-native.config.js` `dependencies` overrides do **not** work for this package | Add the postinstall script that writes a per-package `react-native.config.js` inside `node_modules/@reglobe/lego-core/` (see Step 1.5). Re-run `yarn install` + cache clear. |
| Duplicate module `LegoAPILoggerModule` at runtime | Project still has its own legacy `LegoAPILoggerModule` source files | Delete the legacy files. On iOS also remove the pbxproj references (use `sed -i '' '/LegoAPILogger/d' ios/<App>.xcodeproj/project.pbxproj` after backing up). |
| `Cannot find name 'LegoApiLogger'` in JS even after install | `yarn install` cached an old plugin snapshot (file: deps in yarn v1 are copies, not symlinks) | Run `yarn install --force` and restart TS server in the IDE. |
| `Cannot find module 'LegoApiLogger'` in Swift | Pods not refreshed, or Swift module name mismatch | `cd ios && pod install`. Verify import is `import LegoApiLogger` (not `react_native_lego_api_logger`). |
| iOS module loads but captures nothing | `RCTSetCustomNSURLSessionConfigurationProvider` not called, or called after `startReactNative` | Move the call earlier in `didFinishLaunchingWithOptions`, before `RCTReactNativeFactory` is instantiated. |
| Android module loads but captures nothing | `LegoAPILoggerInterceptor` not added to OkHttp builder | Verify `initHttpClient()` is called from `onCreate()` BEFORE `loadReactNative(this)`. |
| `LegoApiLogger.enable()` runs but nothing logs on Android | The host project uses a custom OkHttp client that doesn't go through `OkHttpClientProvider` | Manually attach `LegoAPILoggerInterceptor()` to that custom builder too. |
| `Header.tsx` typing error: `Routes.API_LOGGER` doesn't exist | The project has no centralized `Routes` constant | Use the string literal `'ApiLogger'` directly instead. |
| Screen crashes on open with `Cannot find module '@react-native-clipboard/clipboard'`, or `Clipboard.setString is not a function` | The clipboard peer dependency is missing, or it was installed without a native rebuild | Add `"@react-native-clipboard/clipboard": "^1.11.0"` to `dependencies`, then `yarn install`, `cd ios && pod install`, and rebuild the app. A Metro reload alone will not link a native module. |

---

## What this skill does NOT do

- **Does not migrate** an existing in-house API logger module (e.g. an old `LegoAPILoggerPackage` in the project's own native code). If detected, list the conflict and ask the user to confirm deletion before proceeding.
- **Does not modify** production builds' release flavors. iOS interception defaults to DEBUG-only per Step 0; Android logging is gated by the JS-side `LegoApiLogger.start()` call (no production overhead unless explicitly invoked).
- **Does not add** any analytics integration, crash reporting, or remote log forwarding. Logs are in-memory only (max 500), cleared on app kill.
- **Does not handle** non-Kotlin Android (Java `MainApplication.java`) or non-Swift iOS (ObjC `.m` / ObjC++ `.mm` AppDelegate). If detected, stop and inform the user.

---

## Final Output to User

After all edits succeed and Step 6 commands have been run, summarize for the user:

```
Integrated react-native-lego-api-logger v<X.Y.Z>:
- package.json: added dependency
- ios/<App>/AppDelegate.swift: hooked URLProtocol via RCTSetCustomNSURLSessionConfigurationProvider
- android/.../MainApplication.kt: added OkHttp interceptor + EventListener
- <entry file>: added LegoApiLogger.start() call (gated on <env flag>)
- <navigator file>: registered ApiLogger route

Next: build, navigate to ApiLogger to view live logs.
```

If any step was skipped (e.g. no React Navigation, no env-flag gating), note it explicitly.
