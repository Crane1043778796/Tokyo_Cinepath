package main

import "time"

// ===========================
// 模块：领域模型定义（数据库表结构）
// 职责：集中定义 Movies / Cinemas / Schedules 等核心实体
// ===========================

// Movie 影片表：存储基础元数据与评分信息（与前端 UI / 合约文档对齐）。
type Movie struct {
	ID uint `gorm:"primaryKey"`

	// 外部 ID：便于后续做外链 / 增量更新
	TMDBID int    // tmdb_id
	IMDBID string // imdb_id

	// 标题与创作信息
	TitleCN  string // 中文标题
	TitleEN  string // 英文标题
	TitleJP  string // 日文标题
	Director string
	Year     string

	// 文案与视觉素材
	Synopsis string
	Poster   string
	Backdrop string

	// 影片时长与类型（类型暂用逗号分隔字符串，后续可拆表）
	Runtime int
	Genre   string

	// 主演等信息以 JSON 数组存储，API 层解包为结构化字段
	CastJSON string `gorm:"type:text"`

	// 评分信息
	TMDBRating   float64
	IMDBRating   float64
	DoubanRating float64

	// 放映状态与上映日期
	Status      string    // showing / incoming
	ReleaseDate time.Time // 上映日期

	// 策展文案
	CuratorNote string

	CreatedAt time.Time
	UpdatedAt time.Time
}

// Schedule 排片表：连接 Movie 与 Cinema，并记录某天的多场次。
type Schedule struct {
	ID        uint      `gorm:"primaryKey"`
	MovieID   uint      // 影片 ID
	CinemaID  uint      // 影院 ID
	PlayDate  time.Time // 放映日期
	StartTime string    // 开始时间（HH:mm）
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ===========================
// 模块：初始化种子数据
// 职责：为开发环境注入少量高质量样例影片，便于前端对接与 UI 调试
// ===========================

func seedInitialMovies() error {
	var count int64
	if err := db.Model(&Movie{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		// 已经有数据，则不再重复写入。
		return nil
	}

	nowShowingDate, _ := time.Parse("2006-01-02", "2026-01-21")
	incomingDate, _ := time.Parse("2006-01-02", "2026-01-24")

	movies := []Movie{
		{
			TitleCN:      "狩猎",
			TitleEN:      "THE HUNT",
			Director:     "Thomas Vinterberg",
			Year:         "2012",
			Synopsis:     "一个关于谎言如何像病毒一样扩散，撕裂一个小镇的温情表象。",
			Poster:       "",
			Backdrop:     "",
			TMDBRating:   8.1,
			IMDBRating:   8.3,
			DoubanRating: 9.1,
			Status:       "showing",
			ReleaseDate:  nowShowingDate,
			CuratorNote:  "本周聚焦独立影院中的人本主义，讲述那些被主流忽视的声音。",
		},
		{
			TitleCN:      "蜘蛛侠：纵横宇宙",
			TitleEN:      "ACROSS THE SPIDER-VERSE",
			Director:     "Kemp Powers",
			Year:         "2023",
			Synopsis:     "迈尔斯回归，一场跨越多元宇宙的奇幻冒险即将开启。",
			Poster:       "",
			Backdrop:     "",
			TMDBRating:   8.4,
			IMDBRating:   8.6,
			DoubanRating: 8.5,
			Status:       "incoming",
			ReleaseDate:  incomingDate,
			CuratorNote:  "多元宇宙中的超级英雄成长记录。",
		},
	}

	return db.Create(&movies).Error
}


// seedInitialSchedules 为已有的影院和影片生成少量演示用排片数据。
// 约定：
// - 如果没有影院或电影，则不做任何事（避免在空库上失败）。
func seedInitialSchedules() error {
	var cinemaCount, movieCount int64
	if err := db.Model(&Cinema{}).Count(&cinemaCount).Error; err != nil {
		return err
	}
	if err := db.Model(&Movie{}).Count(&movieCount).Error; err != nil {
		return err
	}
	if cinemaCount == 0 || movieCount == 0 {
		return nil
	}

	var existing int64
	if err := db.Model(&Schedule{}).Count(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}

	var cinemas []Cinema
	if err := db.Limit(2).Find(&cinemas).Error; err != nil {
		return err
	}
	var movies []Movie
	if err := db.Find(&movies).Error; err != nil {
		return err
	}
	if len(cinemas) == 0 || len(movies) == 0 {
		return nil
	}

	today, _ := time.Parse("2006-01-02", "2026-01-23")
	schedules := []Schedule{
		{MovieID: movies[0].ID, CinemaID: cinemas[0].ID, PlayDate: today, StartTime: "10:40"},
		{MovieID: movies[0].ID, CinemaID: cinemas[0].ID, PlayDate: today, StartTime: "15:40"},
		{MovieID: movies[0].ID, CinemaID: cinemas[0].ID, PlayDate: today, StartTime: "18:20"},
	}
	if len(movies) > 1 && len(cinemas) > 1 {
		schedules = append(schedules,
			Schedule{MovieID: movies[1].ID, CinemaID: cinemas[1].ID, PlayDate: today, StartTime: "14:00"},
			Schedule{MovieID: movies[1].ID, CinemaID: cinemas[1].ID, PlayDate: today, StartTime: "19:00"},
		)
	}
	return db.Create(&schedules).Error
}


