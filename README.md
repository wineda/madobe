# madobe（窓辺）

ブラウザで動く「天気と時間帯の生きたシーン」の棚。Three.js で描いた環境映像を切り替えて眺める、作業用の背景映像（BGV）アプリです。

- 音はありません。映像と「シーンの増やしやすさ」に集中しています
- 各シーンは固定映像ではなく、雨量・風・日の高さなどをスライダーで動かせます
- ビルド不要。Three.js を CDN から読むだけの静的サイトです（スマホ対応）

## 動かす

`file://` で直接開くとスクリプトを読めない場合があるので、静的サーバーを使ってください。

```sh
npx serve .
# または
python3 -m http.server 8000
```

ブラウザで `http://localhost:3000`（serve）または `http://localhost:8000` を開きます。

### GitHub Pages で公開する

`main` にプッシュすると GitHub Actions（`.github/workflows/pages.yml`）が自動で GitHub Pages にデプロイします。

初回だけ、リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にしてください。
有効化する前に走ったワークフローは「Create Pages site failed」で失敗するので、有効化したあとに
**Actions → Deploy to GitHub Pages → Re-run all jobs** を押すか、次のプッシュを待ちます。

公開 URL は `https://<ユーザー名>.github.io/madobe/` です。

### アプリとしてインストールする（PWA）

公開 URL（https）または `localhost` で開くと、PWA としてインストールできます。

- **Android / PC の Chrome・Edge**：右下パネルの「インストール」ボタン、またはアドレスバーのインストールアイコン
- **iOS / iPadOS の Safari**：共有メニュー →「ホーム画面に追加」（iOS には `beforeinstallprompt` がないのでボタンは出ません）

インストール後は全画面（`display: fullscreen`）で起動し、ホーム画面のショートカットから各シーンを直接開けます。
`sw.js` がアプリ本体と three.js・フォントをキャッシュするので、2回目以降はオフラインでも動きます。
ファイルを増やしたら `sw.js` の `APP_FILES` に足し、中身を変えたら `VERSION` を上げてください（古いキャッシュを捨てるため）。

## 操作

| 操作 | 内容 |
| --- | --- |
| 上部のタブ | シーン切替。URL ハッシュ（`#night-rain`）で直リンクできます |
| 右下のスライダー | シーンごとのパラメータ |
| UIを隠す | 上下の UI をフェードアウト。画面タップ / `Esc` で戻ります |
| 全画面 | `requestFullscreen`（iOS Safari では効きません） |
| インストール | PWA としてホーム画面 / デスクトップに追加（ブラウザが対応しているときだけ表示） |
| キーボード | `h` UI 表示切替、`f` 全画面、`←` `→` シーン切替 |

## シーン

| id | 名前 | パラメータ |
| --- | --- | --- |
| `night-rain` | 街灯の夜雨 | 雨量 / 風 / 落下速度 |
| `dusk-rain` | 夕暮れの雨 | 日の高さ / 雨量 / 風 |
| `campfire` | 焚き火 | 火の勢い / 風 / 火の粉 / 煙 |
| `windy-meadow` | 風の草原 | 風の強さ / ゆらぎ β / 日の高さ |

雨の2シーンは路肩の草が「風」に合わせて揺れます。焚き火は炎・火の粉・煙が同じ「風」でなびきます。

焚き火は夜の森の空き地です。炎はノイズを流すのではなく、小さな格子の上で **流体シミュレーション**（浮力・巻き込み・渦）を GPU で解いて動かすので、舌のように伸びてくびれ、ちぎれる動きが計算から出てきます。光は距離の 2 乗で弱まり（物理的な減衰）、炎と同じ拍で明滅して影を踊らせます。割れ目が赤く熾る炭化した薪、息をするように明滅する熾、煤けた石、木立の影、天の川のかかる星空まで、画像ファイルは使わずすべて起動時に手続き生成しています。
風の草原はなだらかな丘が続く草原で、青空の積雲が風で流れます。風の強さが **1/f ゆらぎ** で刻々と変わり、「ゆらぎ β」でその質を変えられます（0 = 白色でせわしない、1 = 1/f で自然、2 = ブラウンでゆったり）。

## シーンを追加する

1. `src/scenes/` にファイルを1つ置く
2. `index.html` の `<script>` 一覧に1行足す

これだけです。各シーンファイルはグローバルの `madobe.register()` を1回呼びます。

```js
madobe.register({
  id: 'night-rain',              // URL ハッシュに使う。英小文字とハイフン
  name: '街灯の夜雨',            // 画面左下のタイトル
  meta: 'rain · night',          // タイトル下の小さなキャプション
  params: [                      // ここからスライダーを自動生成
    { key: 'count', label: '雨量', min: 200, max: 3000, step: 100, value: 1800 },
    { key: 'wind',  label: '風',   min: -6,  max: 6,    step: 0.5, value: 1.5 },
  ],
  create(ctx) {
    // ctx = { THREE, renderer, scene, camera, params, reduceMotion, helpers }
    // scene にオブジェクトを追加し、camera を配置する
    return {
      update(dt, t, params) {},   // 毎フレーム。dt は秒（0.05 でクランプ済み）、t は経過秒
      render(renderer, scene, camera) {}, // 描画を自前でやる場合（省略可。ポストエフェクト用）
      onParam(key, value) {},     // スライダー変更時（省略可）
      dispose() {},               // 自前で作った RenderTarget などの解放（省略可）
    };
  },
});
```

### アプリ側がやること

- `THREE.WebGLRenderer` は1つだけ作り、全シーンで共有する
- シーン切替時は旧 `scene` を traverse して geometry / material / texture を dispose する
- `renderer.shadowMap.enabled`・`physicallyCorrectLights`・`toneMapping`・`toneMappingExposure` はシーンごとにリセットする（シーン側が `create` 内で設定してよい）
- `render` フックがあるシーンはそれを呼び、なければ `renderer.render(scene, camera)` を呼ぶ
- `resize` で `renderer.setSize` と `camera.aspect` を更新する
- `prefers-reduced-motion` のときはカメラの揺れを止める（`ctx.reduceMotion` で渡す）

### 共通ヘルパー（`ctx.helpers`）

- `makeRain(THREE, scene, { max, area, color, opacity })` → `{ mesh, update(dt, { count, wind, speed }, onLand) }`
  雨粒は `LineSegments`。1粒＝2頂点で、落下方向ベクトルに沿って線分を伸ばします。着地時に `onLand(x, z)` を呼び、上端で再生成します
- `makeRipples(THREE, scene, { count, color, maxOpacity, speed })` → `{ spawn(x, z), update(dt) }`
  `RingGeometry` のプールを再利用して地面の波紋を広げます
- `makeGrass(THREE, scene, { count, place(i) → [x, z], clusters, height, blades, bladeWidth, spread, color, roughness })` → `{ mesh, update(dt, t, { wind, sway, gustPhase, gustAmp }) }`
  風に揺れる草むら。3枚の葉を交差させた株を `InstancedMesh` で並べ（1ドローコール）、頂点シェーダーで根元を固定したまま先端を曲げます。`place` が `[x, z, y]` を返せば起伏のある地面にも置けます。`wind` はシーンの風パラメータと同じ単位、`sway` は揺れの強さ（0 で静止）。`gustPhase` と `gustAmp` を渡すと、風下へ進む突風の帯が草原を渡っていきます（位相に風速の積分を入れると風が強いほど速く進む）
- `makeFluctuation({ octaves, baseFreq })` → `{ sample(t, beta) }`
  1/f ゆらぎ（ピンクノイズ）の時間関数。周波数が 2 倍ずつ違うなめらかな値ノイズを重ね、各オクターブの振幅を 2^(-k(β-1)/2) にしてパワースペクトルを 1/f^β にします。`sample(t, beta)` は概ね -1〜1。風の強さ・炎の明滅・光のちらつきなど「一定でも乱雑でもない」変化に使います
- `makeFire(THREE, renderer, scene, { width, height, res, emitters, planes, bright, position, camera, tune, sparks: { max }, smoke: { max, lit, ambient, opacity } })` → `{ group, flicker, update(dt, t, { power, wind, sparks, smoke, viewWidth, viewHeight, pixelRatio }), dispose(), simulated }`
  流体シミュレーションで動かす炎。`width × height`（m）の範囲を `res`（既定 192×288）の格子に切り、1/60 秒ごとに「渦度 → 速度の移流と外力（浮力・風・渦の補強・乱れ）→ 燃料と熱の移流と燃焼 → 発散 → 圧力（ヤコビ法）→ 圧力勾配を引く」を GPU で解きます。熱い気体が浮力で加速しながら昇り、まわりの空気を巻き込んでくびれ、渦でちぎれる——炎の形と動きはこの計算の結果です。`emitters` は火元の線分 `{ x1, y1, x2, y2, r, w }`（薪の上面や熾の並びを正面から見た形で与える）で、線に沿った位置ごとに強さが移ろいます。結果は板に加算合成（HDR）で映します。`planes` に `{ sim: 1, z, scale, … }` を足すと、別の流れで解いた炎を手前に重ねて厚みを出せます。`sparks` は残像つきの筋で描く火の粉（ときどき薪がはぜてまとまって飛ぶ）、`smoke` は炎の光を受けて染まる煙。`flicker.value` は火元の強さに連動するので、光源の強さに掛けると炎が伸びる拍で光も明滅します。`tune` は流体の調整値（`buoy` 浮力・`vort` 渦の補強・`turb` 乱れ・`damp` 減衰・`burn` 燃える速さ・`cool` 冷める速さ・`expand` 膨張）。半精度浮動小数のレンダーターゲットに描けない環境では自動で `makeFlame` に切り替わります（`simulated` が `false`）。自前のレンダーターゲットを持つので、シーンの `dispose` で `dispose()` を呼びます
- `makeFlame(THREE, scene, { layers, width, height, bright, position, camera, embers: { max }, smoke: { max, tint, opacity } })` → `{ group, flicker, update(dt, t, { power, wind, embers, smoke, pixelHeight }) }`
  ノイズで作る軽い炎（`makeFire` が使えない環境の代役。ろうそくや灯籠のような小さな火にも向く）。細長い板を `layers` 枚、少しずつ角度をずらして重ね、常にカメラの方へ向けます。形と色はフラグメントシェーダーで作ります：起動時に生成したノイズテクスチャ（継ぎ目なく繰り返す fBm）を上向きに流し、大きなうねりで全体をしならせ、輪郭をなだらかにぼかしつつ、温度に応じた黒体放射風の色（暗赤→橙→黄→白）を付けます（画像ファイル不要・加算合成・HDR）。`power` は火の勢い（1 が基準）、`wind` で先端がなびきます。`embers` で根元から舞い上がる火の粉、`smoke` で先端から立ちのぼる煙（`Points`）が付き、`update` で表示数を変えられます。`flicker.value`（約 0.8〜1.2、1/f ゆらぎ）を光源の強さに掛けると、光が炎と同じ拍で明滅します
- `makePost(THREE, renderer, { bloom, threshold, vignette, grain, weights })` → `{ render(scene, camera, { time, haze, bloom, exposure }), dispose(), hdr }`
  ポストエフェクト。HDR のレンダーターゲット（WebGL2 なら半精度浮動小数・MSAA）にシーンを描き、ブルーム（発光の滲み）と陽炎（`haze = { x, y, width, height, strength, lean }` で指定した範囲の空気の歪み。`lean` は上へ行くほど横へ流す量）を掛け、ACES トーンマッピングと sRGB 変換をして画面に出します。ブルームは解像度を半分ずつ落とした 5 段のぼかしを `weights` で足し合わせるので、火の粉のまわりの小さな滲みから炎を包む大きな暈までが一度に出ます。最後に粒状のノイズ（`grain`）を足して、暗い空のグラデーションに出る縞を消します。使うシーンは `create` で `renderer.toneMapping = THREE.NoToneMapping` にし（アプリ側が切替時に戻します）、`render` フックから `post.render` を呼び、`dispose` で `post.dispose()` を呼びます
- `makeNoiseTexture(THREE)` → `THREE.DataTexture`
  継ぎ目なく繰り返す fBm ノイズ（256×256、RGBA に別々の 4 種類）。シェーダーで模様やゆらぎを作るときに引きます。シーンのオブジェクトに付けない場合は自分で `dispose()` します

## ファイル構成

```
madobe/
├─ index.html            シェル。タブ・タイトル・パネル・スクリプト読み込み
├─ manifest.webmanifest  PWA のマニフェスト（名前・アイコン・表示モード・ショートカット）
├─ sw.js                 Service Worker（アプリ本体と CDN のキャッシュ）
├─ icons/                PWA のアイコン（icon.svg が元。PNG は 192 / 512 / maskable / apple-touch）
├─ src/app.js            レンダラ、シーン切替、UI自動生成、共通ヘルパー、PWA の登録
├─ src/scenes/
│  ├─ night-rain.js      街灯の夜雨
│  ├─ dusk-rain.js       夕暮れの雨
│  ├─ campfire.js        焚き火
│  └─ windy-meadow.js    風の草原（1/f ゆらぎの風）
├─ .github/workflows/pages.yml   GitHub Pages への自動デプロイ
└─ README.md
```

## 技術メモ

- Three.js r128 の UMD ビルド（cdnjs）。グローバル `THREE` を使います。ES Modules 版へ移行するときは `importmap` を使い、バンドラは入れません
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` で高 DPI 端末の負荷を抑えています
- 雨粒は最大 3000。それ以上はシェーダー化（InstancedBufferGeometry）を検討します
- 焚き火の流体シミュレーションは 1 ステップあたり 30 回ほどの小さな描画（192×288）で、画面全体の描画に比べれば軽い処理です。重いのは地面の柔らかい影（点光源 2 灯 × 16 点のぼかし）なので、指で操作する端末では影の点数と格子を減らし、それでもコマ落ちが続くときは描画の解像度を自動で下げます
- 焚き火のテクスチャ（地面・石・樹皮・炭・木立）は起動時に Canvas で描きます。初回は 0.5〜数秒かかるので、一度作ったものは保持して、シーンに戻ったときに使い回します
- 1シーンあたりの `update` は 60fps が目標。スマホで重いシーンは `params` の初期値を下げます
- フォントは見出しが Shippori Mincho、数値・ラベルが IBM Plex Mono（Google Fonts）。フォールバック指定あり

## ロードマップ（優先度順）

1. 雨以外のシーンを1つ追加して「天気全般」の棚にする（雪、霧、晴れの夕焼けのどれか）
2. シーン切替時のクロスフェード
3. 時間帯の自動進行モード（現在時刻でシーンと日の高さを変える）
4. 雨粒のシェーダー化（GPU 側で動かし、数万粒でも軽くする）
5. 地面に `Reflector` で本物の映り込み
6. 音（外部サービスへのリンクか、ユーザーが選んだ音源の再生のみ。自作しない）

v0 で作らないもの：音、アカウント、設定の保存・共有、シーンエディタ、作業タイマー
