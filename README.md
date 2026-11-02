# 仕入れ帳

カナダ（Facebook Marketplace など）で仕入れて、日本のメルカリで売る商品を管理するアプリです。
iPhone のホーム画面に入れると、普通のアプリと同じように全画面で使えます（PWA）。

- 商品ごとの原価（CAD → 円、国際送料・関税込み）と利益・利益率・ROI
- 在庫 / 出品中 / 売却済 の管理、写真付きの一覧
- 投資額、月の利益・売上目標と達成率、月別グラフ、ブランド別成績
- メルカリの売り切れ検索を条件付きで開き、貼り付けた価格から相場（中央値など）を計算・保存
- 相場から「CADでいくらまで仕入れていいか」を逆算
- 為替レートの取得、JSON でのバックアップ

## 構成

ビルド不要の静的サイトです。データと写真は Supabase に保存します。

| ファイル | 内容 |
|---|---|
| `index.html` / `styles.css` / `app.js` | アプリ本体 |
| `config.js` | Supabase の接続情報 |
| `sw.js` / `manifest.webmanifest` / `icons/` | ホーム画面アプリ用の設定とアイコン |
| `supabase/schema.sql` | データベースと写真置き場の設定 |
| `vendor/supabase.js` | Supabase のライブラリ（v2.45.4） |

## セットアップ

### 1. Supabase
1. プロジェクトを作る（Region は Tokyo）
2. 左メニュー **SQL Editor** → `supabase/schema.sql` の中身を全部貼り付けて **Run**
3. **Project Settings → API** の Project URL と anon public キーを `config.js` に入れる
4. **Authentication → URL Configuration** の Site URL に、公開したアプリの URL を入れる（確認メールのリンク先）

### 2. 公開（Vercel）
1. https://vercel.com に GitHub でログイン
2. **Add New → Project** でこのリポジトリを選び **Deploy**（設定は何も変えなくてOK）
3. 表示された URL を開く

### 3. 最初のログイン
1. アプリで「はじめて使う（アカウント作成）」→ 確認メールのリンクを押す → ログイン
2. 自分のアカウントができたら、Supabase の **Authentication → Sign In / Providers** で
   **Allow new users to sign up** をオフにする（他の人がアカウントを作れないようにする）

### 4. iPhone のホーム画面に入れる
Safari でアプリを開く → 共有ボタン → **ホーム画面に追加**

## 更新するとき
ファイルを変えたら `sw.js` の `VERSION` を上げてください。古い画面が残らないようにするためです。
