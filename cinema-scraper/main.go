package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	// 模块：外部依赖
	// - colly：影院页面抓取
	// - gin：REST API Server
	// - gorm + sqlite：ORM 与嵌入式数据库
	"github.com/gocolly/colly/v2"
	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// ===========================
// 模块：第三方电影数据源配置
// 职责：集中管理 TMDB / OMDb 等外部接口的密钥
// 说明：
// - 这里先按你的旧代码直接内嵌常量，方便本地开发与演示。
// - 如需上线，建议改为从环境变量中读取，避免明文出现在仓库中。
// ===========================
const (
	TMDB_API_KEY = "9393cc205618e50033dd935732772699"
	OMDB_API_KEY = "949a7886"
	// 是否启用豆瓣评分抓取：
	// - 默认关闭（false），避免触发豆瓣风控要求登录。
	// - 如需在本地短时间测试，可以手动改为 true，但请控制请求频率。
	ENABLE_DOUBAN_RATING = false
)

type Cinema struct {
	ID            uint   `gorm:"primaryKey"`
	NameJP        string `gorm:"uniqueIndex"`
	Address       string
	Latitude      float64
	Longitude     float64
	BuildingPhoto string
	Website       string
	UpdatedAt     time.Time
}

var db *gorm.DB

func main() {
	var err error

	// ===========================
	// 模块：数据库初始化
	// 职责：建立 SQLite 连接并完成基础表迁移
	// ===========================
	db, err = gorm.Open(sqlite.Open("tokyo_cinepath.db"), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}
	db.AutoMigrate(&Cinema{}, &Movie{}, &Schedule{})

	// 如果是首次运行，为 Movie / Schedule 表插入少量种子数据，便于前端对接与开发调试。
	if err := seedInitialMovies(); err != nil {
		log.Fatalf("seed movies failed: %v", err)
	}
	if err := seedInitialSchedules(); err != nil {
		log.Fatalf("seed schedules failed: %v", err)
	}

	// ===========================
	// 模块：运行模式切换（API / 爬虫命令 / 补全脚本）
	// 职责：
	// - 默认模式：仅启动 HTTP API Server，方便前端开发调试。
	// - 命令模式：
	//     - `go run . crawl-cinemas`    只执行影院基础信息抓取
	//     - `go run . crawl-schedules`  只执行排片信息抓取
	//     - `go run . fill-douban`      单独补全缺失的豆瓣评分（不会重复抓排片）
	// ===========================
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "crawl-cinemas":
			fmt.Println("🚀 [crawl-cinemas] 影院数据深度抓取中 (清洗地址 + 过滤图片)...")
			syncCinemasBetter()
			fmt.Println("✅ [crawl-cinemas] 抓取完成，程序退出。")
			return
		case "crawl-schedules":
			fmt.Println("🎞️ [crawl-schedules] 影院排片抓取中 (影片 + 场次)...")
			if err := syncSchedulesFromEiga(); err != nil {
				log.Fatalf("crawl-schedules failed: %v", err)
			}
			fmt.Println("✅ [crawl-schedules] 排片抓取完成，程序退出。")
			return
		case "fill-douban":
			fmt.Println("📚 [fill-douban] 开始为缺失豆瓣评分的影片补全评分（仅按英文名 + 年份查询）...")
			if err := backfillDoubanRatings(); err != nil {
				log.Fatalf("fill-douban failed: %v", err)
			}
			fmt.Println("✅ [fill-douban] 豆瓣评分补全任务完成，程序退出。")
			return
		case "update-status":
			fmt.Println("🔄 [update-status] 开始根据排片日期批量更新电影状态...")
			if err := updateMovieStatusFromSchedules(); err != nil {
				log.Fatalf("update-status failed: %v", err)
			}
			fmt.Println("✅ [update-status] 状态更新完成，程序退出。")
			return
		}
	}

	// ===========================
	// 模块：HTTP API Server 启动
	// 职责：启动 Gin 服务，暴露 RESTful 接口给前端调用
	// ===========================
	gin.SetMode(gin.ReleaseMode)
	router := setupRouter()
	fmt.Println("🌐 API server listening on :8080")
	if err := router.Run(":8080"); err != nil {
		log.Fatal(err)
	}
}

func syncCinemasBetter() {
	c := colly.NewCollector(colly.AllowedDomains("eiga.com"))
	detailC := c.Clone()

	detailC.OnHTML("main", func(e *colly.HTMLElement) {
		rawName := e.ChildText("h1.page-title")
		if rawName == "" {
			return
		}
		nameJP := regexp.MustCompile(`（.*?）`).ReplaceAllString(rawName, "")

		// 1. 获取图片：排除包含 shared, banner, ad, coupon 等关键字的图
		var realImg string
		e.ForEach("img", func(_ int, img *colly.HTMLElement) {
			src := img.Attr("src")
			// 只有包含 theater 或 photo 路径的通常才是真正的建筑图
			if strings.Contains(src, "/theater/") && !strings.Contains(src, "shared") && realImg == "" {
				realImg = src
			}
		})

		// 2. 获取影院官方页面链接：映画館情報・割引情報表格中的「映画館公式ページ」
		website := strings.TrimSpace(e.ChildAttr("a.icon.official", "href"))
		if website != "" && !strings.HasPrefix(website, "http") {
			website = e.Request.AbsoluteURL(website)
		}
		// 控制台打印：影院详情页 URL 与官方站点 URL
		fmt.Printf("🔗 影院详情页: %s\n   官方站点: %s\n", e.Request.URL.String(), website)

		// 3. 获取地址并清洗
		// 原始地址: 東京都新宿区新宿3-15-15 新宿ピカデリー内
		// 清洗后: 東京都新宿区新宿3-15-15
		address := strings.TrimSpace(e.ChildText(".location dd"))
		cleanAddr := cleanAddressForGeo(address)

		// 4. 获取唯一经纬度 (带重试逻辑和清洗)
		lat, lng := getCoordsFromOSMWithRetry(cleanAddr, nameJP)

		cinema := Cinema{
			NameJP:        nameJP,
			Address:       address,
			Latitude:      lat,
			Longitude:     lng,
			BuildingPhoto: realImg,
			Website:       website,
			UpdatedAt:     time.Now(),
		}

		db.Where(Cinema{NameJP: nameJP}).Assign(cinema).FirstOrCreate(&cinema)

		fmt.Printf("📍 [%s]\n   地址: %s\n   坐标: %.5f, %.5f\n   图片: %s\n\n", nameJP, cleanAddr, lat, lng, realImg)

		// 必须严格遵守频率限制，否则 OSM 会封锁你返回一模一样的默认坐标
		time.Sleep(2 * time.Second)
	})

	c.OnHTML(".theater-area-list a", func(e *colly.HTMLElement) {
		link := e.Request.AbsoluteURL(e.Attr("href"))
		fmt.Printf("🧭 列表入口链接: %s\n", link)
		if strings.Contains(link, "/theater/13/") {
			detailC.Visit(link)
		}
	})

	c.Visit("https://eiga.com/theater/13/")
}

// ===========================
// 模块：排片同步（Movies + Schedules）
// 职责：从 eiga.com 的影院详情页抓取影片与场次，写入 Movie / Schedule 表
// 调用方式：`go run . crawl-schedules`
// ===========================

func syncSchedulesFromEiga() error {
	// 复用 theater/13 列表页，遍历所有影院详情链接
	c := colly.NewCollector(colly.AllowedDomains("eiga.com"))
	detailC := c.Clone()

	// 影院详情页：抓取影片与场次
	detailC.OnHTML("main", func(e *colly.HTMLElement) {
		rawName := e.ChildText("h1.page-title")
		if rawName == "" {
			return
		}
		nameJP := regexp.MustCompile(`（.*?）`).ReplaceAllString(rawName, "")

		fmt.Printf("🎬 抓取影院排片: %s\n   详情页: %s\n", nameJP, e.Request.URL.String())

		// 在数据库中找到对应的 Cinema（按日文名匹配）
		var cinema Cinema
		if err := db.Where("name_jp = ?", nameJP).First(&cinema).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				fmt.Printf("⚠️ 未在数据库中找到影院记录，跳过排片: %s\n", nameJP)
				return
			}
			fmt.Printf("⚠️ 查询影院失败 [%s]: %v\n", nameJP, err)
			return
		}

		// 每个 section#mXXXXXX 对应一部影片及其一周排片
		e.ForEach("section[id^=m]", func(_ int, sec *colly.HTMLElement) {
			titleJP := strings.TrimSpace(sec.ChildText("h2 a"))
			if titleJP == "" {
				return
			}

			// 1. 确保 Movie 存在（按 TitleJP 去重）
			var movie Movie
			if err := db.Where(&Movie{TitleJP: titleJP}).First(&movie).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					movie = Movie{
						TitleJP: titleJP,
						Status:  "showing",
					}
					if err := db.Create(&movie).Error; err != nil {
						fmt.Printf("⚠️ 创建影片失败 [%s]: %v\n", titleJP, err)
						return
					}
					fmt.Printf("   ➕ 新影片写入: %s (ID=%d)\n", titleJP, movie.ID)
				} else {
					fmt.Printf("⚠️ 查询影片失败 [%s]: %v\n", titleJP, err)
					return
				}
			}

			// 无论是新片还是已存在的影片，只要关键信息尚未补全，
			// 都尝试调用外部接口（TMDB / IMDb / 豆瓣）进行一次信息聚合。
			enrichMovieRatings(&movie)

			// 收集所有排片日期，用于判断电影状态
			playDatesMap := make(map[string]bool) // 使用 map 去重

			// 2. 解析一周排片表：table.weekly-schedule > td[data-date]
			sec.ForEach("table.weekly-schedule td[data-date]", func(_ int, td *colly.HTMLElement) {
				dateRaw := strings.TrimSpace(td.Attr("data-date")) // 例如 20260127
				if len(dateRaw) != 8 {
					return
				}
				playDate, err := time.Parse("20060102", dateRaw)
				if err != nil {
					return
				}

				// 收集排片日期（去重）
				dateStr := playDate.Format("2006-01-02")
				playDatesMap[dateStr] = true

				// 每个 span 代表一个场次，如 "18:05～20:00" 或 "11:00"
				td.ForEach("span", func(_ int, sp *colly.HTMLElement) {
					text := strings.TrimSpace(sp.Text)
					if text == "" {
						return
					}
					// 只关心开始时间，去掉 "~" 及后面的结束时间
					if idx := strings.IndexAny(text, "～ "); idx != -1 {
						text = text[:idx]
					}
					if len(text) < 4 || !strings.Contains(text, ":") {
						return
					}

					sched := Schedule{
						MovieID:   movie.ID,
						CinemaID:  cinema.ID,
						PlayDate:  playDate,
						StartTime: text,
					}

					if err := db.Where("movie_id = ? AND cinema_id = ? AND play_date = ? AND start_time = ?",
						movie.ID, cinema.ID, playDate, text,
					).FirstOrCreate(&sched).Error; err != nil {
						fmt.Printf("⚠️ 写入排片失败 [%s @ %s %s]: %v\n", titleJP, nameJP, text, err)
						return
					}
				})
			})

			// 3. 根据排片日期更新电影状态
			// 逻辑：
			// - 如果有今天或过去的排片 → showing
			// - 如果所有排片都在未来：
			//   * 最早排片在明天到未来7天内 → incoming（Soon：今天还没上映，明天开始一周内有排片）
			//   * 最早排片在7天之后 → showing（更远的未来，暂时不算 Soon）
			if len(playDatesMap) > 0 {
				today := time.Now()
				todayStr := today.Format("2006-01-02")
				tomorrow := today.AddDate(0, 0, 1)
				tomorrowStr := tomorrow.Format("2006-01-02")
				sevenDaysLater := today.AddDate(0, 0, 7)
				
				var earliestDate *time.Time
				hasPastOrToday := false
				
				// 找到最早的排片日期，并检查是否有今天或过去的排片
				for dateStr := range playDatesMap {
					parsedDate, err := time.Parse("2006-01-02", dateStr)
					if err != nil {
						continue
					}
					
					if dateStr <= todayStr {
						hasPastOrToday = true
					}
					
					if earliestDate == nil || parsedDate.Before(*earliestDate) {
						earliestDate = &parsedDate
					}
				}
				
				// 更新电影状态
				newStatus := "showing"
				if !hasPastOrToday && earliestDate != nil {
					// 所有排片都在未来
					// Soon 的定义：今天还没上映，最早排片在明天到未来7天内
					if earliestDateStr := earliestDate.Format("2006-01-02"); earliestDateStr >= tomorrowStr {
						// 最早排片在明天或之后
						if earliestDate.Before(sevenDaysLater) || earliestDate.Equal(sevenDaysLater) {
							// 最早排片在未来7天内 → incoming（Soon）
							newStatus = "incoming"
						}
						// 否则：最早排片在7天之后 → showing（更远的未来）
					}
				}
				
				if movie.Status != newStatus {
					oldStatus := movie.Status
					movie.Status = newStatus
					db.Model(&movie).Update("status", newStatus)
					fmt.Printf("   🔄 更新影片状态 [%s]: %s -> %s (最早排片: %s)\n", titleJP, oldStatus, newStatus, earliestDate.Format("2006-01-02"))
				}
			}
		})
	})

	// 列表页：遍历所有影院详情链接
	c.OnHTML(".theater-area-list a", func(e *colly.HTMLElement) {
		link := e.Request.AbsoluteURL(e.Attr("href"))
		if strings.Contains(link, "/theater/13/") {
			fmt.Printf("🧭 排片入口链接: %s\n", link)
			detailC.Visit(link)
		}
	})

	if err := c.Visit("https://eiga.com/theater/13/"); err != nil {
		return err
	}
	return nil
}

// ===========================
// 模块：豆瓣评分离线补全脚本
// 职责：
// - 避免每次 crawl-schedules 时都去敲豆瓣（降低被风控概率）
// - 只遍历“当前豆瓣评分为 0，但 TMDB / IMDb 信息已齐”的影片
// - 使用英文片名 + 年份在豆瓣搜索，每次请求前 sleep 3 秒
// 调用方式：
//   go run . fill-douban
// ===========================

func backfillDoubanRatings() error {
	// 只处理：豆瓣评分为 0，且已经有英文名与年份的影片
	var movies []Movie
	if err := db.Where("douban_rating = 0 AND title_en <> '' AND year <> ''").Find(&movies).Error; err != nil {
		return err
	}
	if len(movies) == 0 {
		fmt.Println("ℹ️ 没有需要补全豆瓣评分的影片，直接退出。")
		return nil
	}

	fmt.Printf("ℹ️ 共有 %d 部影片准备尝试补全豆瓣评分。\n", len(movies))

	for i, m := range movies {
		fmt.Printf("[%d/%d] 尝试补全豆瓣评分: TitleEN=%s Year=%s\n", i+1, len(movies), m.TitleEN, m.Year)
		score := fetchDoubanRating(m.TitleEN, m.Year)
		if score <= 0 {
			fmt.Printf("   ↪ 豆瓣评分未找到或被风控，跳过当前影片。\n")
			continue
		}

		m.DoubanRating = score
		if err := db.Save(&m).Error; err != nil {
			fmt.Printf("⚠️ 保存豆瓣评分失败 [%s]: %v\n", m.TitleEN, err)
			continue
		}
		fmt.Printf("   ⭐ 豆瓣评分更新成功 [%s]: %.1f\n", m.TitleEN, score)
	}

	return nil
}

// ===========================
// 模块：影片信息与评分补全（TMDB + IMDb + 豆瓣）
// 职责：
// - 基于日文片名从 TMDB 拉取多语言基础信息（中 / 日 / 英标题、简介、海报、导演、年份等）
// - 基于 IMDb ID 从 OMDb 拉取 IMDb 评分
// - 基于中文名 + 年份从豆瓣抓取评分
// ===========================

func enrichMovieRatings(m *Movie) {
	// 如果已经补全过基础信息和评分，并且 ReleaseDate 也不是零值，就不再重复调用外部接口，节省配额。
	// 注意：之前有一版逻辑没有考虑 ReleaseDate，可能导致字段齐全但上映日期为 0001-01-01 的旧数据。
	if m.TitleCN != "" && m.TitleEN != "" && m.TMDBRating > 0 && !m.ReleaseDate.IsZero() {
		return
	}

	cleanTitle := strings.TrimSpace(m.TitleJP)
	if cleanTitle == "" {
		return
	}

	// 1) 先用日文片名在 TMDB 上查到 tmdbID
	tmdbID := searchTmdbID(cleanTitle)
	if tmdbID == 0 {
		fmt.Printf("⚠️ TMDB 未找到影片: %s\n", cleanTitle)
		return
	}
	// 记录到模型中，方便后续排查 / 外链
	if m.TMDBID == 0 {
		m.TMDBID = tmdbID
	}

	var imdbID string

	// 2) 分语言拉取 TMDB 详情：zh-CN / ja-JP / en-US
	langs := []string{"zh-CN", "ja-JP", "en-US"}
	for _, lang := range langs {
		apiURL := fmt.Sprintf(
			"https://api.themoviedb.org/3/movie/%d?api_key=%s&language=%s&append_to_response=credits,videos",
			tmdbID, TMDB_API_KEY, lang,
		)
		fmt.Printf("🌐 TMDB 详情查询 [%s]: %s\n", lang, apiURL)

		client := &http.Client{Timeout: 10 * time.Second}
		req, _ := http.NewRequest("GET", apiURL, nil)
		req.Header.Set("User-Agent", "TokyoCinePath/1.1 (tmdb-detail)")

		resp, err := client.Do(req)
		if err != nil || resp == nil {
			if err != nil {
				fmt.Printf("⚠️ TMDB 详情请求失败 [%s]: %v\n", lang, err)
			}
			continue
		}

		var data struct {
			ImdbID       string  `json:"imdb_id"`
			Title        string  `json:"title"`
			Overview     string  `json:"overview"`
			PosterPath   string  `json:"poster_path"`
			BackdropPath string  `json:"backdrop_path"`
			ReleaseDate  string  `json:"release_date"`
			Runtime      int     `json:"runtime"`
			VoteAverage  float64 `json:"vote_average"`
			Genres       []struct {
				Name string `json:"name"`
			} `json:"genres"`
			Credits struct {
				Cast []struct {
					Name        string `json:"name"`
					Character   string `json:"character"`
					ProfilePath string `json:"profile_path"`
				} `json:"cast"`
				Crew []struct {
					Name string `json:"name"`
					Job  string `json:"job"`
				} `json:"crew"`
			} `json:"credits"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
			resp.Body.Close()
			continue
		}
		resp.Body.Close()

		// 公共字段：优先用中文的评分 / 简介，如果没有再用其他语言
		if data.VoteAverage > 0 && m.TMDBRating == 0 {
			m.TMDBRating = data.VoteAverage
		}
		if m.Synopsis == "" && strings.TrimSpace(data.Overview) != "" {
			m.Synopsis = data.Overview
		}
		if data.PosterPath != "" && m.Poster == "" {
			m.Poster = "https://image.tmdb.org/t/p/w500" + data.PosterPath
		}
		if data.BackdropPath != "" && m.Backdrop == "" {
			m.Backdrop = "https://image.tmdb.org/t/p/original" + data.BackdropPath
		}
		if data.ReleaseDate != "" {
			if m.Year == "" && len(data.ReleaseDate) >= 4 {
				m.Year = data.ReleaseDate[:4]
			}
			// 同步精确上映日期到模型的 ReleaseDate 字段（time.Time）
			if m.ReleaseDate.IsZero() {
				if t, err := time.Parse("2006-01-02", data.ReleaseDate); err == nil {
					m.ReleaseDate = t
				}
			}
		}
		if data.Runtime > 0 && m.Runtime == 0 {
			m.Runtime = data.Runtime
		}
		if len(data.Genres) > 0 && m.Genre == "" {
			parts := make([]string, 0, len(data.Genres))
			for _, g := range data.Genres {
				if strings.TrimSpace(g.Name) != "" {
					parts = append(parts, g.Name)
				}
			}
			m.Genre = strings.Join(parts, ", ")
		}
		if m.Director == "" {
			for _, crew := range data.Credits.Crew {
				if crew.Job == "Director" {
					m.Director = crew.Name
					break
				}
			}
		}

		// 从 zh-CN / en-US 的 credits.cast 里补全 CastJSON（只做一次）
		if (lang == "zh-CN" || lang == "en-US") && m.CastJSON == "" && len(data.Credits.Cast) > 0 {
			limit := len(data.Credits.Cast)
			if limit > 8 {
				limit = 8
			}
			type castOut struct {
				Name string `json:"name"`
				Role string `json:"role"`
				Img  string `json:"img"`
			}
			out := make([]castOut, 0, limit)
			for i := 0; i < limit; i++ {
				c := data.Credits.Cast[i]
				img := ""
				if c.ProfilePath != "" {
					img = "https://image.tmdb.org/t/p/w185" + c.ProfilePath
				}
				out = append(out, castOut{
					Name: c.Name,
					Role: c.Character,
					Img:  img,
				})
			}
			if b, err := json.Marshal(out); err == nil {
				m.CastJSON = string(b)
			}
		}

		// 不同语言分别填充 TitleCN / TitleJP / TitleEN
		switch lang {
		case "zh-CN":
			if data.Title != "" {
				m.TitleCN = data.Title
			}
			if imdbID == "" {
				imdbID = data.ImdbID
			}
		case "ja-JP":
			if data.Title != "" && m.TitleJP == "" {
				m.TitleJP = data.Title
			}
		case "en-US":
			if data.Title != "" {
				m.TitleEN = data.Title
			}
			if imdbID == "" {
				imdbID = data.ImdbID
			}
		}
	}

	// 3) IMDb 评分（通过 OMDb）
	if imdbID != "" {
		m.IMDBID = imdbID
		imdbRating, raw := fetchImdbRating(imdbID)
		m.IMDBRating = imdbRating

		// 你的要求：如果 TMDB 有评分而 IMDb 却是 0，打印出 IMDb 原始返回，方便人工核对。
		if m.TMDBRating > 0 && imdbRating == 0 {
			fmt.Printf("⚠️ IMDb 评分为 0 但 TMDB 有分: TitleJP=%s TitleEN=%s TMDBID=%d IMDbID=%s Raw=%s\n",
				m.TitleJP, m.TitleEN, m.TMDBID, imdbID, raw)
		}
	}

	// 4) 如果 TMDB 没给出精确日期，但我们有年份，则用该年份的 1 月 1 日作为保底上映日期
	if m.ReleaseDate.IsZero() && m.Year != "" {
		if t, err := time.Parse("2006-01-02", m.Year+"-01-01"); err == nil {
			m.ReleaseDate = t
		}
	}

	// 5) 豆瓣评分（通过网页抓取，可选）
	//   按你的最新要求：优先使用英文名去豆瓣搜索，避免中文名歧义。
	if ENABLE_DOUBAN_RATING && m.TitleEN != "" && m.Year != "" {
		m.DoubanRating = fetchDoubanRating(m.TitleEN, m.Year)
	}

	// 如果到这里 ReleaseDate 仍然是零值，说明 TMDB 返回中没有 release_date，
	// 且我们也没有 year 信息可兜底，在控制台打一个提示方便你去对照 TMDB。
	if m.ReleaseDate.IsZero() {
		fmt.Printf("⚠️ 仍然缺少上映日期: TitleJP=%s TitleCN=%s Year=%s TMDBID=%d\n",
			m.TitleJP, m.TitleCN, m.Year, m.TMDBID)
	}

	if err := db.Save(m).Error; err != nil {
		fmt.Printf("⚠️ 保存影片信息失败 [%s]: %v\n", m.TitleJP, err)
	} else {
		fmt.Printf("🎥 已补全影片信息: %s | CN:%s EN:%s | TMDB:%.1f | IMDb:%.1f | 豆瓣:%.1f\n",
			m.TitleJP, m.TitleCN, m.TitleEN, m.TMDBRating, m.IMDBRating, m.DoubanRating)
	}
}

// searchTmdbID 使用日文片名在 TMDB 搜索并返回第一个结果的 ID。
func searchTmdbID(title string) int {
	u := fmt.Sprintf(
		"https://api.themoviedb.org/3/search/movie?api_key=%s&query=%s&language=ja-JP",
		TMDB_API_KEY, url.QueryEscape(title),
	)
	fmt.Printf("🌐 TMDB 搜索 URL: %s\n", u)

	resp, err := http.Get(u)
	if err != nil || resp == nil {
		return 0
	}
	defer resp.Body.Close()

	var res struct {
		Results []struct {
			ID int `json:"id"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return 0
	}
	if len(res.Results) > 0 {
		return res.Results[0].ID
	}
	// 关键调试信息：当 TMDB 没有返回任何结果时，打印出本次搜索使用的 URL，方便你复制到浏览器里直接查看。
	fmt.Printf("⚠️ TMDB 搜索无结果: TitleJP=%s URL=%s\n", title, u)
	return 0
}

// fetchImdbRating 通过 OMDb API 获取 IMDb 评分，同时返回原始响应字符串，便于调试。
func fetchImdbRating(imdbID string) (float64, string) {
	if imdbID == "" {
		return 0, ""
	}
	u := fmt.Sprintf("http://www.omdbapi.com/?i=%s&apikey=%s", imdbID, OMDB_API_KEY)
	fmt.Printf("🌐 OMDb 查询 URL: %s\n", u)

	resp, err := http.Get(u)
	if err != nil || resp == nil {
		return 0, ""
	}
	defer resp.Body.Close()

	var rawBuf strings.Builder
	tee := io.TeeReader(resp.Body, &rawBuf)

	var data struct {
		Rating string `json:"imdbRating"`
	}
	if err := json.NewDecoder(tee).Decode(&data); err != nil {
		return 0, rawBuf.String()
	}
	val, _ := strconv.ParseFloat(data.Rating, 64)
	return val, rawBuf.String()
}

// fetchDoubanRating 通过抓取豆瓣搜索结果页，提取评分。
func fetchDoubanRating(title string, year string) float64 {
	var rating float64
	u := fmt.Sprintf("https://www.douban.com/search?cat=1002&q=%s", url.QueryEscape(title))
	fmt.Printf("🌐 豆瓣搜索 URL: %s\n", u)

	// 为减少被风控风险，按你的要求：每次请求前强制等待 3 秒。
	time.Sleep(3 * time.Second)

	c := colly.NewCollector()
	c.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	c.OnHTML(".result", func(e *colly.HTMLElement) {
		if rating != 0 {
			return
		}
		resTitle := e.ChildText(".title a")
		resMeta := e.ChildText(".subject-cast")
		// 简单校验年份或标题
		if strings.Contains(resMeta, year) || strings.Contains(resTitle, title) {
			rStr := e.ChildText(".rating_nums")
			rating, _ = strconv.ParseFloat(rStr, 64)
		}
	})
	if err := c.Visit(u); err != nil {
		fmt.Printf("⚠️ 豆瓣请求失败（可能被风控要求登录），已跳过评分同步: %v\n", err)
		return 0
	}

	if rating == 0 {
		fmt.Printf("ℹ️ 未能从豆瓣匹配到评分: %s (%s)\n", title, year)
	}
	return rating
}

// 地址清洗函数：只保留到门牌号，去掉“某某大楼内”或“几楼”
func cleanAddressForGeo(addr string) string {
	// 匹配常见的门牌号格式（如 1-5-16 或 3丁目15-15）
	re := regexp.MustCompile(`(.*?\d+丁目\d+-\d+)|(.*?\d+-\d+-\d+)|(.*?\d+-\d+)`)
	match := re.FindString(addr)
	if match != "" {
		return match
	}
	return addr
}

// updateMovieStatusFromSchedules 根据排片日期批量更新所有电影的状态
func updateMovieStatusFromSchedules() error {
	var movies []Movie
	if err := db.Find(&movies).Error; err != nil {
		return fmt.Errorf("查询电影失败: %v", err)
	}

	today := time.Now()
	todayStr := today.Format("2006-01-02")

	updatedCount := 0
	for _, movie := range movies {
		// 查询该电影的所有排片
		var schedules []Schedule
		if err := db.Where("movie_id = ?", movie.ID).Find(&schedules).Error; err != nil {
			continue
		}

		if len(schedules) == 0 {
			// 没有任何排片：视为「未排片」，单独标记，前端默认不展示
			newStatus := "unplanned"
			if movie.Status != newStatus {
				if err := db.Model(&movie).Update("status", newStatus).Error; err != nil {
					fmt.Printf("⚠️ 更新电影状态失败 [%s]: %v\n", movie.TitleJP, err)
					continue
				}
				fmt.Printf("   🔄 [%s]: %s -> %s (无任何排片)\n", movie.TitleJP, movie.Status, newStatus)
				updatedCount++
			}
			continue
		}

		// 找到最早的排片日期 + 最晚的排片日期 + 是否存在「今天或之前」的排片
		var earliestDate *time.Time
		var latestDate *time.Time
		hasPastOrToday := false

		for _, sched := range schedules {
			dateStr := sched.PlayDate.Format("2006-01-02")
			if dateStr <= todayStr {
				hasPastOrToday = true
			}
			if earliestDate == nil || sched.PlayDate.Before(*earliestDate) {
				earliestDate = &sched.PlayDate
			}
			if latestDate == nil || sched.PlayDate.After(*latestDate) {
				latestDate = &sched.PlayDate
			}
		}

		// 先检查：如果所有排片都已经过期（最晚排片 < 今天），标记为 unplanned
		if latestDate != nil {
			latestDateStr := latestDate.Format("2006-01-02")
			if latestDateStr < todayStr {
				// 所有排片都已经过去，标记为 unplanned
				newStatus := "unplanned"
				if movie.Status != newStatus {
					if err := db.Model(&movie).Update("status", newStatus).Error; err != nil {
						fmt.Printf("⚠️ 更新电影状态失败 [%s]: %v\n", movie.TitleJP, err)
						continue
					}
					fmt.Printf("   🔄 [%s]: %s -> %s (最晚排片: %s，已全部过期)\n", movie.TitleJP, movie.Status, newStatus, latestDateStr)
					updatedCount++
				}
				continue
			}
		}

		// 判断新状态（按你的期望精确收敛）：
		// - showing：存在「今天或之前」的任意排片，且最晚排片 >= 今天（至少还有未过期的场次）
		// - incoming (Soon)：所有排片都在未来，且最早排片在明天到未来 7 天内
		// - future：所有排片都在未来，且最早排片在 7 天之后 —— 大概率是数据问题，前端默认不展示
		newStatus := "showing"
		if !hasPastOrToday && earliestDate != nil {
			tomorrow := today.AddDate(0, 0, 1)
			sevenDaysLater := today.AddDate(0, 0, 7)

			earliest := earliestDate.Truncate(24 * time.Hour)
			if earliest.Before(tomorrow) {
				// 理论上不会进入（因为没有 pastOrToday），防御性留空
				newStatus = "incoming"
			} else if (earliest.Equal(tomorrow) || earliest.After(tomorrow)) && (earliest.Before(sevenDaysLater) || earliest.Equal(sevenDaysLater)) {
				// 明天 ~ 7 天内
				newStatus = "incoming"
			} else if earliest.After(sevenDaysLater) {
				// 超过 7 天的未来排片：标为 future（第三状态），前端可选择不展示
				newStatus = "future"
			}
		}

		// 更新状态
		if movie.Status != newStatus {
			if err := db.Model(&movie).Update("status", newStatus).Error; err != nil {
				fmt.Printf("⚠️ 更新电影状态失败 [%s]: %v\n", movie.TitleJP, err)
				continue
			}
			fmt.Printf("   🔄 [%s]: %s -> %s (最早排片: %s)\n", movie.TitleJP, movie.Status, newStatus, earliestDate.Format("2006-01-02"))
			updatedCount++
		}
	}

	fmt.Printf("✅ 共更新 %d 部电影的状态\n", updatedCount)
	return nil
}

func getCoordsFromOSMWithRetry(address string, name string) (float64, float64) {
	// 尝试一：用清洗后的详细地址
	lat, lng, err := callOSM(address)
	if err == nil {
		return lat, lng
	}

	// 尝试二：如果失败，只用“新宿区 + 影院名”去搜
	district := ""
	if strings.Contains(address, "区") {
		district = address[:strings.Index(address, "区")+3]
	}
	lat, lng, err = callOSM(district + " " + name)
	if err == nil {
		return lat, lng
	}

	// 最终保底方案：如果都搜不到，在东京站附近随机偏移一点，至少不重叠
	// (这在没有 API Key 时是保证地图不重叠的常用 Trick)
	randomOffset := float64(time.Now().UnixNano()%1000) / 100000.0
	return 35.6895 + randomOffset, 139.6917 + randomOffset
}

func callOSM(query string) (float64, float64, error) {
	apiURL := fmt.Sprintf("https://nominatim.openstreetmap.org/search?q=%s&format=json&limit=1", url.QueryEscape(query))

	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET", apiURL, nil)
	req.Header.Set("User-Agent", "TokyoCinePath/1.1 (yourname@gmail.com)")

	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	var results []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	json.NewDecoder(resp.Body).Decode(&results)

	if len(results) > 0 {
		lat, _ := strconv.ParseFloat(results[0].Lat, 64)
		lng, _ := strconv.ParseFloat(results[0].Lon, 64)
		return lat, lng, nil
	}
	return 0, 0, fmt.Errorf("no results")
}
