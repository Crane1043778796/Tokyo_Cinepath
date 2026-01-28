# Tokyo CinePath 前后端对接文档（Contract）

> 目标：用后端 Gin API 替换前端 `tokyo-cine-frontend/src/App.jsx` 里的 `MOVIES_DATA`、`CINEMAS_DATA` mock 数据，并与 `Tokyo CinePath.md` 的功能保持一致。
>
> 当前现状：
> - 后端已有：`cinema-scraper/main.go` 具备 **影院抓取 + 地址清洗 + OSM 地理编码 + SQLite(GORM)落库**（目前只迁移了 `Cinema` 表）。
> - 前端已有：Vite+React 单页应用，包含 Browse/Archive/Cinemas 三视图；想看/已看使用 `localStorage`。

---

## 1. 约定与原则

- **API 基础路径**：`/api`
- **数据格式**：JSON（UTF-8）
- **时间/日期格式**：
  - `release_date` / `play_date`：`YYYY-MM-DD`
  - `start_time`：`HH:mm`（24 小时制）
  - 时间戳：`ts` 使用毫秒 `Unix ms`
- **状态枚举**：
  - 电影：`status ∈ {"showing","incoming"}`
- **前端持久化**：
  - `watchlist`/`history` 暂时保持在 `localStorage`（不依赖后端账号系统）。

---

## 2. 前端现有功能 → 需要的后端能力

### 2.1 Browse（Now / Soon）

前端页面（`view="browse"`）依赖能力：
- **Now（showing）**：支持按评分排序（IMDb / 豆瓣），支持搜索。
- **Soon（incoming）**：支持按 `release_date` 过滤，支持搜索。
- 列表项卡片字段需求（用于 `MovieCard`）：
  - `id`, `title_cn`, `title_en`, `director`, `year`
  - `imdb_rating`, `douban_rating`（`tmdb_rating` 可选）
  - `poster`（当前前端临时用统一图，也可先返回空）
  - `status`, `release_date`
  - `cinemas`（至少能给出影院数量/名称）

### 2.2 Movie Detail（沉浸式详情）

详情页（`DetailView`）依赖能力：
- 影片详情字段：
  - `synopsis`, `curator_note`
  - `cast: [{name, role, img}]`
  - `cinemas: [{id, name, schedule: [{date, times[]}]}]`

### 2.3 Cinemas（地图 + Bottom Sheet）

影院页（`view="cinemas"`）依赖能力：
- 地图 Marker 与影院列表：
  - `id`, `name`, `en`, `district`, `lat`, `lng`
  - `tags`, `website`, `desc`
- 影院详情抽屉：
  - `daily_movies: [{ id(movieId), title, times[], rating }]`

### 2.4 Archive（想看 / 已看）

当前实现：仅本地 `localStorage`：
- `unseen_wl_vfinal`: `number[]`
- `unseen_hi_vfinal`: `{ [movieId]: { cinema, time, ts } }`

> 说明：对接第一阶段 **无需** 后端用户/同步接口；可在后续阶段扩展。

---

## 3. 数据模型（建议与实现对齐）

### 3.1 Movies（影片表）

建议字段（可按阶段逐步补齐）：
- `id` (PK)
- `tmdb_id`, `imdb_id`
- `title_cn`, `title_en`, `title_jp`
- `synopsis`
- `poster`, `backdrop`
- `director`
- `cast_json`（JSON 数组）
- `tmdb_rating`, `imdb_rating`, `douban_rating`
- `status`（showing/incoming）
- `release_date`
- `year`, `genre`, `runtime`
- `curator_note`

### 3.2 Cinemas（影院表）

现有 Go 代码里已存在并落库：
- `id`, `name_jp (unique)`, `address`, `latitude`, `longitude`, `building_photo`, `updated_at`

建议新增：
- `name_en`, `district`, `tags_json`, `website`, `desc`

### 3.3 Schedules（排片表）

核心关联表（用于聚合 daily schedule / 影片多馆排片）：
- `id`
- `movie_id`
- `cinema_id`
- `play_date`（YYYY-MM-DD）
- `start_time`（HH:mm）

---

## 4. API 列表（第一阶段：前端对接必需）

### 4.1 获取电影列表（Browse）

- **Method**：`GET`
- **Path**：`/api/movies`
- **Query**（均可选）：
  - `status`: `"showing"` | `"incoming"`
  - `sort`: `"imdb_rating"` | `"douban_rating"`（推荐仅在 `status=showing` 时允许）
  - `date`: `YYYY-MM-DD`（推荐仅在 `status=incoming` 时允许）
  - `q`: 搜索关键字（匹配 `title_cn`/`title_en`）

**Response**

```json
{
  "items": [
    {
      "id": 1,
      "title_cn": "狩猎",
      "title_en": "THE HUNT",
      "director": "Thomas Vinterberg",
      "year": "2012",
      "tmdb_rating": 8.1,
      "imdb_rating": 8.3,
      "douban_rating": 9.1,
      "duration": "115m",
      "poster": "https://...",
      "status": "showing",
      "release_date": "2026-01-21",
      "genre": "DRAMA",
      "curator_note": "本周聚焦于独立影院中的人本主义...",
      "cinemas": [
        {
          "id": 1,
          "name": "早稲田松竹",
          "schedule": [
            { "date": "2026-01-23", "times": ["10:40", "15:40", "18:20"] }
          ]
        }
      ]
    }
  ]
}
```

**前端对应**
- 替换 `tokyo-cine-frontend/src/App.jsx` 中的 `MOVIES_DATA`。
- `displayedMovies` 的排序/过滤逻辑可继续保留在前端，也可逐步迁移到后端。

---

### 4.2 获取电影详情（Detail Overlay）

- **Method**：`GET`
- **Path**：`/api/movies/:id`

**Response**

```json
{
  "id": 1,
  "title_cn": "狩猎",
  "title_en": "THE HUNT",
  "director": "Thomas Vinterberg",
  "year": "2012",
  "synopsis": "一个关于性的谎言如病毒般蔓延...",
  "curator_note": "本周聚焦于独立影院中的人本主义...",
  "imdb_rating": 8.3,
  "douban_rating": 9.1,
  "cast": [
    { "name": "Mads Mikkelsen", "role": "Lucas", "img": "https://..." }
  ],
  "cinemas": [
    {
      "id": 1,
      "name": "早稲田松竹",
      "schedule": [
        { "date": "2026-01-23", "times": ["10:40", "15:40", "18:20"] }
      ]
    }
  ]
}
```

**前端对应**
- 目前前端点击卡片直接把 movie 对象传给 `DetailView`。可先保证列表接口已返回足够字段；需要更全字段时再调用详情接口补齐。

---

### 4.3 获取影院列表（地图 Marker / 影院列表）

- **Method**：`GET`
- **Path**：`/api/cinemas`

**Response**

```json
{
  "items": [
    {
      "id": 1,
      "name": "早稲田松竹",
      "en": "Waseda Shochiku",
      "district": "新宿区",
      "lat": 35.7116,
      "lng": 139.7082,
      "tags": ["#2本立", "#名画座"],
      "website": "http://wasedashochiku.co.jp/",
      "desc": "经典的二本立名画座。位于早稻田大学附近。",
      "building_photo": "https://..."
    }
  ]
}
```

**前端对应**
- 替换 `tokyo-cine-frontend/src/App.jsx` 中的 `CINEMAS_DATA`。
- `CinemaView` 里 Marker 与影院列表使用该接口返回的数据。

---

### 4.4 获取影院详情（含 Daily Schedule）

- **Method**：`GET`
- **Path**：`/api/cinemas/:id`
- **Query（可选）**：
  - `date`: `YYYY-MM-DD`（不传默认今天）

**Response**

```json
{
  "id": 1,
  "name": "早稲田松竹",
  "en": "Waseda Shochiku",
  "district": "新宿区",
  "lat": 35.7116,
  "lng": 139.7082,
  "tags": ["#2本立", "#名画座"],
  "website": "http://wasedashochiku.co.jp/",
  "desc": "经典的二本立名画座。位于早稻田大学附近。",
  "building_photo": "https://...",
  "daily_movies": [
    {
      "id": 1,
      "title": "狩猎",
      "times": ["10:40", "15:40", "18:20"],
      "rating": "8.3"
    }
  ]
}
```

**前端对应**
- 点击 Marker/列表项后，用该接口补齐 `daily_movies`，渲染 Bottom Sheet 的 “Daily Schedule”。

---

## 5. API（第二阶段可选扩展）

### 5.1 Spotlight（Welcome Modal）

- **Method**：`GET`
- **Path**：`/api/movies/spotlight`

用途：替换前端 `WelcomeModal movie={MOVIES_DATA[0]}`。

### 5.2 Archive 云同步（用户系统）

> 暂不做。若未来做账号系统可启用：

- `GET /api/me/archive`
- `POST /api/me/archive`

示例响应：

```json
{
  "watchlist": [1, 3, 5],
  "history": {
    "1": { "cinema": "早稲田松竹", "time": "15:40", "ts": 1737923810000 }
  }
}
```

---

## 6. 对接实施清单（最小可跑通版本）

1. **后端**：在 Go 项目中增加 Gin Server，先实现：
   - `GET /api/cinemas`
   - `GET /api/cinemas/:id`
2. **前端**：把 `CINEMAS_DATA` 改成 API 加载（地图 + 列表立即可用）。
3. **后端**：补 Movies/Schedules 表与基础数据，增加：
   - `GET /api/movies`
   - `GET /api/movies/:id`
4. **前端**：把 `MOVIES_DATA` 改成 API 加载；保留 `localStorage` 的 watchlist/history 逻辑不动。

