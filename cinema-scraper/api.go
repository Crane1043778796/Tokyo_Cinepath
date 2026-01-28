package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ===========================
// 模块：HTTP API 启动与路由
// 职责：挂载 Gin、注册 RESTful 路由
// ===========================

// setupRouter 初始化 Gin 引擎与所有对外暴露的 API 路由。
func setupRouter() *gin.Engine {
	r := gin.Default()

	api := r.Group("/api")
	{
		// 影院相关接口：地图 / 影院详情
		api.GET("/cinemas", listCinemasHandler)
		api.GET("/cinemas/:id", getCinemaHandler)

		// 影片相关接口：Now / Soon 列表与详情
		api.GET("/movies", listMoviesHandler)
		api.GET("/movies/:id", getMovieHandler)
	}

	return r
}

// ===========================
// 模块：影院 API 响应结构体
// 职责：将 GORM 模型转换为前端友好的 JSON 结构
// ===========================

// CinemaItem 用于 /api/cinemas 列表展示（地图 + 列表视图）。
type CinemaItem struct {
	ID            uint     `json:"id"`
	Name          string   `json:"name"`
	NameEN        string   `json:"en"`
	District      string   `json:"district"`
	Lat           float64  `json:"lat"`
	Lng           float64  `json:"lng"`
	Tags          []string `json:"tags"`
	Website       string   `json:"website"`
	Desc          string   `json:"desc"`
	BuildingPhoto string   `json:"building_photo"`
}

// DailyMovie 用于单个影院详情中的每日排片展示。
type DailyMovie struct {
	ID     uint     `json:"id"`
	Title  string   `json:"title"`
	Times  []string `json:"times"`
	Rating string   `json:"rating"`
}

// CinemaDetail 用于 /api/cinemas/:id 详情视图（包含 daily_movies）。
type CinemaDetail struct {
	CinemaItem
	DailyMovies []DailyMovie `json:"daily_movies"`
}

// MovieItem 用于 /api/movies 列表（Now/Soon）。
type MovieItem struct {
	ID           uint    `json:"id"`
	TitleCN      string  `json:"title_cn"`
	TitleEN      string  `json:"title_en"`
	Director     string  `json:"director"`
	Year         string  `json:"year"`
	TMDBRating   float64 `json:"tmdb_rating"`
	IMDBRating   float64 `json:"imdb_rating"`
	DoubanRating float64 `json:"douban_rating"`
	Status       string  `json:"status"`
	ReleaseDate  string  `json:"release_date"` // YYYY-MM-DD（全球首映日期，来自TMDB）
	EarliestScheduleDate string `json:"earliest_schedule_date"` // YYYY-MM-DD（最早排片日期，用于incoming状态显示）
	CinemaCount  int     `json:"cinema_count"`           // 参与放映的影院数量
	PrimaryCinemaName string `json:"primary_cinema_name"` // 当只有一个影院时，显示该影院名称
	Genre        string  `json:"genre"`
	Runtime      int     `json:"runtime"`      // 片长（分钟）
	Poster       string  `json:"poster"`       // 海报 URL
	CuratorNote  string  `json:"curator_note"`
}

// Person 用于影片详情中的演职员信息。
type Person struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Img  string `json:"img"`
}

// MovieCinemaSchedule 用于影片详情中的“多馆排片切换”结构。
type MovieCinemaSchedule struct {
	ID       uint `json:"id"`
	Name     string `json:"name"`
	Schedule []struct {
		Date  string   `json:"date"`
		Times []string `json:"times"`
	} `json:"schedule"`
}

// MovieDetail 用于 /api/movies/:id 影片详情视图。
type MovieDetail struct {
	MovieItem
	Synopsis string                `json:"synopsis"`
	Cast     []Person              `json:"cast"`
	Cinemas  []MovieCinemaSchedule `json:"cinemas"`
}

// ===========================
// 模块：影院 API 处理函数
// 职责：查询数据库，返回 JSON
// ===========================

// listCinemasHandler 影院列表接口：
// - 用于前端地图 Marker 和影院列表的基础数据来源。
// - 当前阶段：从 Cinemas 表中读取所有影院记录，部分字段使用占位/推导值。
func listCinemasHandler(c *gin.Context) {
	var cinemas []Cinema
	if err := db.Find(&cinemas).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query cinemas"})
		return
	}

	items := make([]CinemaItem, 0, len(cinemas))
	for _, cin := range cinemas {
		items = append(items, mapCinemaToItem(cin))
	}

	c.JSON(http.StatusOK, gin.H{
		"items": items,
	})
}

// getCinemaHandler 单个影院详情接口：
// - 用于前端 Bottom Sheet 展示影院详情与 Daily Schedule。
// - 支持可选的 date 查询参数（YYYY-MM-DD），不传则默认使用今天。
func getCinemaHandler(c *gin.Context) {
	id := c.Param("id")

	var cinema Cinema
	if err := db.First(&cinema, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "cinema not found"})
		return
	}

	// 解析可选的 date 参数（YYYY-MM-DD）。不传则默认使用服务器当前日期。
	// 这里直接用 date 字符串做 SQL 的 date(play_date)=? 过滤，避免时区导致“明明有排片但查不到”的问题。
	dateStr := c.Query("date")
	if dateStr == "" {
		dateStr = time.Now().Format("2006-01-02")
	}

	// 查询该影院相关的所有排片，并聚合为 DailyMovies 结构。
	detail := CinemaDetail{
		CinemaItem:  mapCinemaToItem(cinema),
		DailyMovies: buildDailyMoviesForCinema(cinema.ID, dateStr),
	}

	c.JSON(http.StatusOK, detail)
}

// ===========================
// 模块：影片 API 处理函数
// 职责：提供 Now / Soon 列表与基础详情（当前为初始种子数据）
// ===========================

// listMoviesHandler 影片列表接口：
// - 支持通过 query 参数按状态 / 排序键 / 搜索关键字过滤。
func listMoviesHandler(c *gin.Context) {
	status := c.Query("status") // showing / incoming
	sortKey := c.Query("sort")  // imdb_rating / douban_rating
	query := c.Query("q")
	dateStr := c.Query("date") // YYYY-MM-DD，上层 Soon 日期筛选使用

	var movies []Movie
	tx := db

	// 1) 基于 Schedule 做“真排片过滤”
	// 策略调整：
	// - 当传入 date 参数时，严格按这一天在任意影院有排片的影片过滤（用于 Soon 视图的日历筛选）。
	// - 当不传 date 时，只按 status（showing/incoming）过滤，让列表尽可能展示所有可用影片，避免前期数据不全时列表为空。
	if status != "" && dateStr != "" {
		var schedules []Schedule
		schedTx := db.Model(&Schedule{})

		// 解析目标日期
		var targetDate *time.Time
		if parsed, err := time.Parse("2006-01-02", dateStr); err == nil {
			targetDate = &parsed
		}

		switch status {
		case "showing":
			if targetDate != nil {
				schedTx = schedTx.Where("date(play_date) = ?", targetDate.Format("2006-01-02"))
			}
		case "incoming":
			if targetDate != nil {
				schedTx = schedTx.Where("date(play_date) = ?", targetDate.Format("2006-01-02"))
			}
		}

		if err := schedTx.Find(&schedules).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query schedules"})
			return
		}

		if len(schedules) == 0 {
			// 没有任何匹配排片，直接返回空列表。
			c.JSON(http.StatusOK, gin.H{"items": []MovieItem{}})
			return
		}

		// 收集涉及到的 MovieID
		idSet := make(map[uint]struct{})
		for _, s := range schedules {
			idSet[s.MovieID] = struct{}{}
		}
		ids := make([]uint, 0, len(idSet))
		for id := range idSet {
			ids = append(ids, id)
		}

		// 按状态过滤：
		// - showing：兼容早期抓取时未正确写入 status 的记录（'' / NULL 也视为 showing）。
		// - incoming：只保留显式标记为 incoming 的影片。
		if status == "showing" {
			tx = tx.Where("id IN ?", ids).Where("(status = ? OR status = '' OR status IS NULL)", status)
		} else {
			tx = tx.Where("id IN ?", ids).Where("status = ?", status)
		}
	} else if status != "" {
		// 没有 date 参数时，仅按状态做基础过滤：
		// - showing：所有正在上映的片 + 早期未写入 status 的记录
		// - incoming：所有明确标记为 incoming 的片
		if status == "showing" {
			tx = tx.Where("(status = ? OR status = '' OR status IS NULL)", status)
		} else {
			tx = tx.Where("status = ?", status)
		}
	}

	// 2) 搜索：按中/英文标题模糊匹配（修正列名为 title_cn / title_en）
	if query != "" {
		pattern := "%" + query + "%"
		tx = tx.Where("title_cn LIKE ? OR title_en LIKE ?", pattern, pattern)
	}

	// 3) 排序：按 IMDb 或豆瓣评分倒序
	if sortKey == "imdb_rating" {
		tx = tx.Order("imdb_rating DESC")
	} else if sortKey == "douban_rating" {
		tx = tx.Order("douban_rating DESC")
	}

	if err := tx.Find(&movies).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query movies"})
		return
	}

	items := make([]MovieItem, 0, len(movies))
	for _, m := range movies {
		item := mapMovieToItem(m)
		
		// 统计该影片参与放映的影院数量 + 最早排片日期
		var firstSchedule Schedule
		if err := db.Where("movie_id = ?", m.ID).Order("play_date ASC").First(&firstSchedule).Error; err == nil {
			item.EarliestScheduleDate = firstSchedule.PlayDate.Format("2006-01-02")
		}

		var cinemaCount int64
		if err := db.Model(&Schedule{}).
			Where("movie_id = ?", m.ID).
			Distinct("cinema_id").
			Count(&cinemaCount).Error; err == nil {
			item.CinemaCount = int(cinemaCount)

			// 当只有一个影院参与放映时，查出该影院名称，供前端展示
			if cinemaCount == 1 {
				var cin Cinema
				if err := db.First(&cin, firstSchedule.CinemaID).Error; err == nil {
					item.PrimaryCinemaName = cin.NameJP
				}
			}
		}
		
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// getMovieHandler 单个影片详情接口：
// - 返回影片的基础元数据 + 简要剧情 + 多馆排片信息。
func getMovieHandler(c *gin.Context) {
	id := c.Param("id")

	var movie Movie
	if err := db.First(&movie, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "movie not found"})
		return
	}

	// 解析 CastJSON 为 Person 数组
	var cast []Person
	if movie.CastJSON != "" {
		if err := json.Unmarshal([]byte(movie.CastJSON), &cast); err != nil {
			// JSON 解析失败时，cast 保持为空数组
			cast = []Person{}
		}
	}

	detail := MovieDetail{
		MovieItem: mapMovieToItem(movie),
		Synopsis:  movie.Synopsis,
		Cast:      cast,
		Cinemas:   buildCinemasForMovie(movie.ID),
	}

	c.JSON(http.StatusOK, detail)
}

// ===========================
// 模块：影院数据映射工具函数
// 职责：从底层模型推导前端需要的字段（区名、标签等）
// ===========================

// mapCinemaToItem 将底层的 Cinema 模型转换为前端友好的 CinemaItem。
// 说明：
// - Name 使用抓取到的日文名（NameJP）。
// - District 尝试从 Address 中截取“**区”，若失败则置空。
// - Tags / Website / Desc 暂时使用占位，后续可通过额外字段或人工策展填充。
func mapCinemaToItem(cn Cinema) CinemaItem {
	return CinemaItem{
		ID:            cn.ID,
		Name:          cn.NameJP,
		NameEN:        "", // 预留：后续可在数据库中补充英文名
		District:      extractDistrict(cn.Address),
		Lat:           cn.Latitude,
		Lng:           cn.Longitude,
		Tags:          []string{}, // 预留：如 #2本立 / #名画座 等
		Website:       cn.Website,
		Desc:          "",
		BuildingPhoto: cn.BuildingPhoto,
	}
}

// extractDistrict 从完整地址中尝试提取“XX区”片段，例如：
// - "東京都新宿区新宿3-15-15 新宿ピカデリー内" -> "新宿区"
func extractDistrict(address string) string {
	if address == "" {
		return ""
	}
	idx := strings.Index(address, "区")
	if idx == -1 {
		return ""
	}
	// 找到“区”前面的一个日文汉字起点（简单切分：从都/道/府/县后开始）
	// 示例："東京都新宿区" -> 从 "東" 之后去掉 "東京都" 留下 "新宿区"
	// 这里采用简化版：直接从最后一个 "都/道/府/県" 后一位开始截取到 "区"。
	start := 0
	for i, r := range address {
		if r == '都' || r == '道' || r == '府' || r == '県' {
			start = i + len("都")
		}
	}
	if start >= idx {
		start = 0
	}
	return strings.TrimSpace(address[start : idx+len("区")])
}

// buildDailyMoviesForCinema 将某个影院的 Schedule + Movie 聚合成前端需要的 DailyMovie 列表。
// targetDate：要展示的日期（从 getCinemaHandler 的 query 参数传入，默认今天）。
func buildDailyMoviesForCinema(cinemaID uint, dateStr string) []DailyMovie {
	var schedules []Schedule
	// 直接在 SQL 层用 date(play_date) 过滤，避免 time.Location 不一致导致的日期偏移
	if err := db.Where("cinema_id = ? AND date(play_date) = ?", cinemaID, dateStr).Find(&schedules).Error; err != nil {
		return []DailyMovie{}
	}
	if len(schedules) == 0 {
		return []DailyMovie{}
	}

	// 加载涉及到的影片信息。
	movieIDs := make(map[uint]struct{})
	for _, s := range schedules {
		movieIDs[s.MovieID] = struct{}{}
	}
	if len(movieIDs) == 0 {
		return []DailyMovie{}
	}

	ids := make([]uint, 0, len(movieIDs))
	for id := range movieIDs {
		ids = append(ids, id)
	}

	var movies []Movie
	if err := db.Where("id IN ?", ids).Find(&movies).Error; err != nil {
		return []DailyMovie{}
	}
	movieMap := make(map[uint]Movie)
	for _, m := range movies {
		movieMap[m.ID] = m
	}

	// 聚合同一影片的多个时间场次。
	dailyMap := make(map[uint]*DailyMovie)
	for _, s := range schedules {
		mv, ok := movieMap[s.MovieID]
		if !ok {
			continue
		}
		if _, exists := dailyMap[mv.ID]; !exists {
			// 标题兜底：CN -> EN -> JP -> "Movie #ID"
			title := strings.TrimSpace(mv.TitleCN)
			if title == "" {
				title = strings.TrimSpace(mv.TitleEN)
			}
			if title == "" {
				title = strings.TrimSpace(mv.TitleJP)
			}
			if title == "" {
				title = fmt.Sprintf("Movie #%d", mv.ID)
			}

			// 评分优先级：豆瓣 > IMDb > TMDB
			rating := mv.DoubanRating
			if rating == 0 {
				rating = mv.IMDBRating
			}
			if rating == 0 {
				rating = mv.TMDBRating
			}
			dailyMap[mv.ID] = &DailyMovie{
				ID:     mv.ID,
				Title:  title,
				Rating: fmt.Sprintf("%.1f", rating),
				Times:  []string{},
			}
		}
		dailyMap[mv.ID].Times = append(dailyMap[mv.ID].Times, s.StartTime)
	}

	result := make([]DailyMovie, 0, len(dailyMap))
	for _, dm := range dailyMap {
		result = append(result, *dm)
	}
	return result
}

// buildCinemasForMovie 将某部影片的 Schedule + Cinema 聚合成前端 DetailView 需要的结构。
func buildCinemasForMovie(movieID uint) []MovieCinemaSchedule {
	var schedules []Schedule
	if err := db.Where("movie_id = ?", movieID).Find(&schedules).Error; err != nil {
		return []MovieCinemaSchedule{}
	}
	if len(schedules) == 0 {
		return []MovieCinemaSchedule{}
	}

	// 预先加载影院信息。
	cinemaIDs := make(map[uint]struct{})
	for _, s := range schedules {
		cinemaIDs[s.CinemaID] = struct{}{}
	}
	if len(cinemaIDs) == 0 {
		return []MovieCinemaSchedule{}
	}

	ids := make([]uint, 0, len(cinemaIDs))
	for id := range cinemaIDs {
		ids = append(ids, id)
	}

	var cinemas []Cinema
	if err := db.Where("id IN ?", ids).Find(&cinemas).Error; err != nil {
		return []MovieCinemaSchedule{}
	}
	cinemaMap := make(map[uint]Cinema)
	for _, c := range cinemas {
		cinemaMap[c.ID] = c
	}

	// 先按影院 + 日期聚合所有场次。
	type key struct {
		cinemaID uint
		date     string
	}
	grouped := make(map[key][]string)
	for _, s := range schedules {
		date := s.PlayDate.Format("1/2") // 与前端 mock 保持类似格式，例如 "1/23"
		k := key{cinemaID: s.CinemaID, date: date}
		grouped[k] = append(grouped[k], s.StartTime)
	}

	// 再按影院组装成 MovieCinemaSchedule。
	cinemaSchedules := make(map[uint]*MovieCinemaSchedule)
	for k, times := range grouped {
		cin, ok := cinemaMap[k.cinemaID]
		if !ok {
			continue
		}
		if _, exists := cinemaSchedules[cin.ID]; !exists {
			cinemaSchedules[cin.ID] = &MovieCinemaSchedule{
				ID:   cin.ID,
				Name: cin.NameJP,
			}
		}
		entry := struct {
			Date  string   `json:"date"`
			Times []string `json:"times"`
		}{
			Date:  k.date,
			Times: times,
		}
		cinemaSchedules[cin.ID].Schedule = append(cinemaSchedules[cin.ID].Schedule, entry)
	}

	out := make([]MovieCinemaSchedule, 0, len(cinemaSchedules))
	for _, cs := range cinemaSchedules {
		out = append(out, *cs)
	}
	return out
}

// mapMovieToItem 将 Movie 模型转换为前端的 MovieItem。
func mapMovieToItem(m Movie) MovieItem {
	releaseDateStr := ""
	if !m.ReleaseDate.IsZero() {
		releaseDateStr = m.ReleaseDate.Format("2006-01-02")
	}

	// 标题回退策略：
	// - 列表主标题优先用中文，其次英文；若都为空，则使用日文 TitleJP（东京影院场景下至少有日文名）。
	titleCN := m.TitleCN
	if titleCN == "" {
		if m.TitleEN != "" {
			titleCN = m.TitleEN
		} else {
			titleCN = m.TitleJP
		}
	}
	titleEN := m.TitleEN
	if titleEN == "" && m.TitleJP != "" {
		titleEN = m.TitleJP
	}

	return MovieItem{
		ID:           m.ID,
		TitleCN:      titleCN,
		TitleEN:      titleEN,
		Director:     m.Director,
		Year:         m.Year,
		TMDBRating:   m.TMDBRating,
		IMDBRating:   m.IMDBRating,
		DoubanRating: m.DoubanRating,
		Status:       m.Status,
		ReleaseDate:  releaseDateStr,
		EarliestScheduleDate: "", // 由调用方填充
		CinemaCount:  0,          // 由调用方填充
		PrimaryCinemaName: "",
		Genre:        m.Genre,
		Runtime:      m.Runtime,
		Poster:       m.Poster,
		CuratorNote:  m.CuratorNote,
	}
}

