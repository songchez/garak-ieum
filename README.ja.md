<p align="center">
  <a href="README.md">한국어</a> · <a href="README.en.md">English</a> · <strong>日本語</strong>
</p>

<p align="center">
  <img src="docs/assets/readme/hero.svg" alt="Garak Ieum — 韓国発の DAW。作曲からピッチ編集まで" width="1200">
</p>

<p align="center">
  <a href="https://github.com/songchez/garak-ieum/releases"><img src="https://img.shields.io/badge/version-0.3.5_Preview-DF5435?style=flat-square" alt="0.3.5 開発プレビュー"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-3D7865?style=flat-square" alt="GPL-3.0-only"></a>
  <img src="https://img.shields.io/badge/platform-Windows_x64_·_macOS_Apple_Silicon-285973?style=flat-square" alt="Windows x64 · macOS Apple Silicon">
</p>

<h1 align="center">Garak Ieum · 가락이음</h1>

**Garak Ieum(가락이음)** は、韓国で開発しているオープンソースの DAW です。ピアノロールでの MIDI 作曲、オーディオ録音、単旋律のピッチ編集、内蔵の音源・エフェクト・ギターアンプ、ミキシング、WAV 書き出しまでを一つのスタジオで扱えます。音はデスクトップ版とブラウザー版が共有する **一つの Rust オーディオエンジン** が作ります。デスクトップ版は Windows では ASIO・WASAPI、macOS では Core Audio を使用します。VST3 プラグインも読み込めます。現在は **開発プレビュー** 段階です。

<!-- TODO: ホームページの URL が決まったら、下の「ホームページ」をリンクに置き換えてください。例: [ホームページ](https://...) -->
機能紹介や詳しいインストール・使い方のガイドは **ホームページ** をご覧ください。

## ダウンロードとインストール

**[GitHub Releases から最新版をダウンロード →](https://github.com/songchez/garak-ieum/releases)**

| OS | インストーラー | インストール方法 |
| --- | --- | --- |
| Windows 64 ビット (x64) | `Garak-Ieum-Setup-<バージョン>-x64.exe` | インストーラーを実行し、画面の案内に従います。 |
| macOS Apple シリコン (M シリーズ) | `Garak-Ieum-Setup-<バージョン>-arm64.dmg` | DMG を開き、`가락이음.app` をアプリケーションフォルダへドラッグします。 |

- Intel Mac と Linux には対応していません。
- インストールしたアプリの実行に Node.js や pnpm は不要です。
- プレビュー版は、Windows の発行元署名および Apple Developer ID による署名・公証を受けていません。初回起動時に SmartScreen や Gatekeeper の警告が表示されることがあります。
- 各リリースには、同じコミットから作成したソース ZIP(`Garak-Ieum-Source-…zip`)と SHA-256 チェックサムも含まれます。ソース ZIP はインストール用ではありません。

OS 別の詳しいガイド(韓国語):[Windows](docs/DESKTOP.md) · [macOS](docs/MACOS.md) · [AI 連携(MCP)](docs/MCP.md)

## ソースからビルド

**Node.js 24.x**、**pnpm 11.25.0**、**CMake 3.25 以上**、そして `rust/rust-toolchain.toml` で固定した **Rust ツールチェーン** が必要です。Windows では Visual Studio 2022(または Build Tools)の「C++ によるデスクトップ開発」と Windows SDK を、macOS では Apple シリコン搭載 Mac と Xcode Command Line Tools を用意してください。Rust はスクリプト一つでインストールできます(rustup が既にあれば固定バージョンだけを追加します)。

```bash
git clone https://github.com/songchez/garak-ieum.git
cd garak-ieum
pnpm install --frozen-lockfile

# Rust ツールチェーン (初回のみ)
powershell -ExecutionPolicy Bypass -File scripts/setup-rust.ps1   # Windows
sh scripts/setup-rust.sh                                          # macOS / Linux

pnpm desktop:dev          # Rust エンジン・C++ ホスト・アプリをビルドして Electron を起動
pnpm desktop:build        # Windows x64 インストーラー (.exe)
pnpm desktop:build:mac    # macOS arm64 DMG
pnpm dev                  # ブラウザーで実行 (AudioWorklet 上の Rust エンジン)
pnpm build                # Web ビルド (garak-engine.wasm を含む)
```

- Web アプリは `garak-engine.wasm` でのみ音を出すため、`pnpm dev` の前に `pnpm rust:wasm` で一度ビルドしてください。モジュールがない場合は音の代わりにエンジンの読み込みエラーを表示します(ビルドして再読み込み)。
- ネイティブビルドは常に Rust エンジン(`rust/garak-ffi`)を cargo でビルドしてリンクします(0.3.3 から必須)。Rust は `scripts/setup-rust.ps1` / `setup-rust.sh` でインストールします。
- Rust のコマンド(`pnpm rust:test`、`rust:check`、`rust:wasm`、`rust:build`)とツールチェーン表は [Rust オーディオコア](docs/RUST.md)(韓国語)にあります。

テスト用コマンド、署名、リリース手順は [デスクトップガイド](docs/DESKTOP.md#4-소스에서-실행하고-빌드하기) と [リリース手順](docs/RELEASING.md)(韓国語)を参照してください。

## アーキテクチャ

```mermaid
flowchart TD
  UI["React エディター · MCP"] --> S["ProjectSession (src/core)"]
  S --> C["レンダラー: NativeTimelineCompiler<br/>RenderPlan → project.set / project.patch"]
  C -->|"Electron IPC"| H["デスクトップ: garak-audio-host (C++ シェル)<br/>デバイス I/O · VST3 ホストノード<br/>トランスポート・マスター · render-ahead リング · 録音"]
  C -->|"メッセージ · SharedArrayBuffer リング"| W["Web: AudioWorklet<br/>garak-engine.wasm"]
  H -->|"C ABI (garak-ffi)"| E["Rust エンジン rust/garak-engine<br/>トラック · 内蔵音源 · ギターリグ · ミックス · センド/リターン · ルート"]
  W -->|"WASM (garak-engine-wasm)"| E
  E --> D["rust/garak-dsp (no_std)<br/>エフェクト · 音源ボイス"]
```

- **単一のプロジェクトモデル** — 画面(React)からの編集も AI(MCP)からの編集も、`src/core` の `ProjectSession` と検証済みコマンドを経由します。プロジェクトはシリアライズ可能なデータで、Undo/Redo の履歴を共有します。
- **ローカル保存** — プロジェクトと元のオーディオは IndexedDB に自動保存され、`.garak` ファイルに書き出して別のマシンで作業を続けられます。アカウントやクラウドのバックエンドはありません。
- **一つの Rust エンジン、二つのホスト** — `rust/garak-engine` がタイムラインからマスター前の合算まで、トラック・内蔵音源・ギターリグ・エフェクト(시김새)・センド/リターン・トラックルートをレンダリングします。デスクトップは C ABI(`rust/garak-ffi`、ヘッダーは `rust/garak-ffi/include`)で、ブラウザーは WASM(`rust/garak-engine-wasm`)で同じコードを使います。エフェクトと音源ボイスは `rust/garak-dsp`(`no_std`)にあります。
- **デスクトップ: 薄い C++ シェル** — `garak-audio-host` の `RenderEngine` はデバイス I/O(ASIO・WASAPI・Core Audio)、VST3(エンジンがコールバックで呼ぶホストノード)、トランスポート・マスターバス・メトロノーム、render-ahead リング、録音を担当し、トラックのレンダリングは Rust エンジンに任せます。トラックは処理レベルごとにワーカースレッドで並列にレンダリングされ、結果は 1 スレッドとビット単位で一致します。ネイティブエンジンが使えない場合はエラーを表示し、Web Audio へ黙って切り替えることはしません。
- **Web: AudioWorklet** — `garak-engine.wasm` が AudioWorklet で動作し、メーターブロック・ライブイベントリング(SharedArrayBuffer)、入力モニタリング、録音タップを扱います。書き出しは Worker で同じエンジンを使ってオフラインレンダリングします。Web で唯一のレンダラーで、代替経路はありません。ブラウザーが AudioWorklet・WebAssembly に対応していないかモジュールを読み込めない場合は明確なエラーを表示し、エンジンが拒否したプロジェクトは理由を示して再生・書き出しが失敗します。
- **レンダー差分プロトコル** — レンダラーは最初に計画全体(`project.set`)を、その後は変更されたトラックだけ(`project.patch`)を送ります。エンジンは制御スレッドの `Controller` とオーディオスレッドの `Renderer` に分かれ、ロックフリーのキューだけで通信するため、オーディオスレッドは割り当てやロックをせず、バッファーごとに JavaScript や IPC の応答を待つこともありません。
- **オフライン処理** — ピッチ編集(Signalsmith WASM)とオーディオワープは Worker で新しい PCM アセットをレンダリングし、元のオーディオはそのまま保持します。

> **旧エンジン:** 0.3.3 でデスクトップの C++ トラック経路・C++ エフェクト DSP・C++ IEUM WAVE シンセと、Web の旧 TS・Web Audio エンジンとそのスイッチ(`garak.rustEngine`、`garak.rustDsp`)を削除しました。両ホストとも Rust エンジンだけでレンダリングします。

詳しくは(韓国語):[アーキテクチャ](docs/ARCHITECTURE.md) · [Rust レンダーエンジン](docs/RUST_ENGINE.md) · [Rust オーディオコア](docs/RUST.md) · [レンダー差分プロトコル](docs/RENDER_DIFF_PROTOCOL.md) · [ネイティブオーディオ](docs/NATIVE_AUDIO.md)

## ドキュメント

ドキュメントの大半は韓国語で書かれています。

| トピック | ドキュメント |
| --- | --- |
| はじめに | [GETTING_STARTED](docs/GETTING_STARTED.md) · [ショートカット](docs/SHORTCUTS.md) |
| 機能ガイド | [ピッチエディター](docs/PITCH_EDITOR.md) · [ギターアンプ](docs/GUITAR_RIG.md) · [IEUM WAVE](docs/IEUM_WAVE.md) · [MIDI 読み込み](docs/MIDI_IMPORT.md) |
| AI 連携 | [MCP](docs/MCP.md) |
| 設計と実装状況 | [アーキテクチャ](docs/ARCHITECTURE.md) · [Rust レンダーエンジン](docs/RUST_ENGINE.md) · [Rust オーディオコア](docs/RUST.md) · [ネイティブオーディオ](docs/NATIVE_AUDIO.md) · [実装状況](docs/IMPLEMENTATION_STATUS.md) · [ロードマップ](docs/ROADMAP.md) |
| リリースとライセンス | [リリース手順](docs/RELEASING.md) · [GPL 配布ガイド](docs/LICENSING.md) |

その他のドキュメントは [`docs/`](docs/) フォルダーにあります。不具合の報告や機能の提案は [Issues](https://github.com/songchez/garak-ieum/issues/new/choose) へお寄せください。コードの貢献は [CONTRIBUTING.md](CONTRIBUTING.md)、セキュリティの問題は [SECURITY.md](SECURITY.md) をご覧ください。

## ライセンス

アプリのコードは [GNU GPL v3.0 only(`GPL-3.0-only`)](LICENSE)で提供しています。以前 MIT で公開したコードの[告知](public/licenses/garak-ieum-MIT-notice.txt)は保持しています。韓国国立国楽院の国楽音源、Lucide アイコン、徳温公主体のワードマーク、Signalsmith DSP などのサードパーティ資産はそれぞれのライセンスに従い、[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) にまとめています。インストーラーを再配布する場合の対応ソースの提供方法は [GPL 配布ガイド](docs/LICENSING.md) をご確認ください。

<p align="center"><sub>가락이음 · Garak Ieum</sub></p>
