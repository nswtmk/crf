# App Store に出すには

このアプリはウェブで作られています。iPhone の**ホーム画面に追加**すればすぐアプリとして
使えますが、**App Store で配信する**には別の作業が要ります。ここではその手順と、
先に知っておくべき条件をまとめます。

## 先に知っておくこと

| 必要なもの | 備考 |
|---|---|
| **Mac** | Xcode は macOS でしか動きません。ここが最大の関門です |
| **Xcode** | 無料。App Store から入れます |
| **Apple Developer Program** | **年 約$99**。これがないと配信できません |
| **プライバシーポリシー** | 公開URLが必要。位置情報と写真を扱うので必須です |
| **審査** | 数日かかります。落ちることもあります |

### 落ちやすい点を2つ

**1. 「ただのウェブサイトの詰め替え」に見えると落ちます**(ガイドライン 4.2)

このアプリは現在地の取得・写真・オフライン動作があるので、単なる詰め替えではありません。
ただ審査員にそう見えないよう、**申請時のメモに何が端末機能を使っているかを書いてください。**

**2. 投稿できるアプリには通報とブロックが要ります**(ガイドライン 1.2)

Apple は、利用者が投稿でき他人に見えるアプリに次を求めています。

- 不適切な内容を通報できること → **実装ずみ**(他人の記録 → 通報する)
- 相手をブロックできること → **実装ずみ**(他人の記録 → この人をブロック)
- 問い合わせ先を掲載すること → **実装ずみ**(設定 → 問い合わせ)
- **通報を24時間以内に確認し、問題があれば削除すること** → **これはあなたの運用です**

最後の1つは仕組みではなく約束です。通報は Supabase の `reports` 表に溜まります。
**Table Editor で `reports` を開き、`status` が `open` のものを確認してください。**
対応したら `status` を `done` にします。

> 通報の運用ができないうちは、**「全体に公開」を使わない**(自分と友達だけで使う)ほうが安全です。
> 公開投稿がなければガイドライン 1.2 の負担は実質ありません。

---

## 手順

### 1. Mac に道具を入れる

```sh
# Xcode を App Store から入れたあと
xcode-select --install
sudo gem install cocoapods      # または brew install cocoapods
```

### 2. このリポジトリを持ってくる

```sh
git clone https://github.com/nswtmk/crf.git
cd crf/map
```

### 3. Capacitor で iOS の入れ物を作る

```sh
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/geolocation
npx cap init --web-dir=.        # capacitor.config.json は用意ずみ
npx cap add ios
npx cap sync
```

### 4. 使用目的の説明を書く

`ios/App/App/Info.plist` に追記します。**日本語で、何に使うかを具体的に。**
「位置情報を使います」だけだと落ちます。

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>行った場所を地図に記録するために現在地を使います。記録はこの端末の中に保存され、あなたが「友達だけ」または「全体に公開」を選んだものだけが共有されます。</string>

<key>NSPhotoLibraryUsageDescription</key>
<string>記録に写真を添えるために写真を読み込みます。写真はこの端末の中に保存されます。</string>

<key>NSCameraUsageDescription</key>
<string>その場で写真を撮って記録に添えるためにカメラを使います。</string>
```

### 5. Xcode で開いて設定する

```sh
npx cap open ios
```

- **Signing & Capabilities** → Team に自分の Apple Developer アカウントを選ぶ
- **Bundle Identifier** を自分のものにする(例 `jp.あなたのドメイン.trailmap`)
- **App Icons** に `icon-512.png` をもとにした画像を入れる

### 6. 実機で試す

iPhone を繋ぎ、Xcode の再生ボタンで動かします。**必ず実機で確認してください。**
とくに現在地の許可、写真の取り込み、地図のドラッグとピンチを触ってください。

### 7. 申請する

1. Xcode の **Product → Archive**
2. **Distribute App** → App Store Connect
3. https://appstoreconnect.apple.com で情報を埋めます

**App Privacy** の欄では、正直に申告してください。

| 項目 | 答え |
|---|---|
| 位置情報 | 収集する(アプリの機能のため。共有設定にしたものだけがサーバーへ) |
| 写真 | 収集する(端末内に保存。現在は共有していません) |
| メールアドレス | 収集する(アカウントのため) |
| ユーザーID | 収集する |
| 広告・追跡 | しない |

---

## 更新するとき

ウェブ側を直したら、次で iOS 側に反映します。

```sh
npx cap sync
npx cap open ios     # そのあと Xcode で Archive
```

## App Store に出さない選択

年 $99 と審査を避けたいなら、**ホーム画面に追加**でほぼ同じ体験になります。

| | ホーム画面に追加 | App Store |
|---|---|---|
| 費用 | 無料 | 年 約$99 |
| 審査 | なし | あり |
| 配りやすさ | URL を送るだけ | 検索で見つかる |
| アイコンから起動 | できる | できる |
| オフライン | できる | できる |
| 現在地・写真 | 使える | 使える |
| プッシュ通知 | 制限あり | 使える |

**人に配る予定がないなら、ホーム画面に追加で十分です。**
