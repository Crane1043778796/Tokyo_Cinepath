import React, { useState, useMemo, useEffect } from 'react';
/* --- 1. 库与图标导入 --- */
import { 
  Film, MapPin, User, Star, X, Play, Compass, Search as SearchIcon, 
  Ticket, Calendar, Heart, Eye, Clock, CheckCircle2, 
  ChevronRight, ChevronDown, AlertCircle, LogOut, Settings, Info, Check, ArrowRight, ExternalLink, ArrowUp 
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import MapGL, { Marker, NavigationControl } from 'react-map-gl'; 
import 'mapbox-gl/dist/mapbox-gl.css';

/* --- 2. 配置与全局样式 --- */
const MAPBOX_TOKEN = 'pk.eyJ1IjoiMTA0Mzc3ODc5NiIsImEiOiJjbWtxbnB1ZG4wdzc1M2RwdnMzNHdxanRuIn0.KhLzjpbGfvbUFvW921EH3w'; 
const THEATER_IMAGE = "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?q=80&w=2070";

const GLOBAL_STYLES = `
  .marker-glow { position: relative; display: flex; align-items: center; justify-content: center; }
  .marker-glow::after {
    content: ''; position: absolute; width: 45px; height: 45px; background: rgba(197, 160, 89, 0.2);
    border-radius: 50%; animation: pulse-gold 2s infinite; pointer-events: none;
  }
  @keyframes pulse-gold { 0% { transform: scale(1); opacity: 0.8; } 70% { transform: scale(2.2); opacity: 0; } 100% { transform: scale(1); opacity: 0; } }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
`;

/* --- 工具函数：带缓存和重试的 API 请求 --- */
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 初始重试延迟1秒

async function fetchWithCacheAndRetry(url, options = {}) {
  const cacheKey = `api_cache_${url}`;
  const now = Date.now();
  
  // 1. 尝试从缓存读取
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (now - timestamp < CACHE_DURATION) {
        return { data, fromCache: true };
      }
    }
  } catch (e) {
    // 缓存读取失败，继续网络请求
  }

  // 2. 网络请求（带重试）
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      
      // 3. 保存到缓存（仅GET请求）
      if (!options.method || options.method === 'GET') {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({
            data,
            timestamp: now
          }));
        } catch (e) {
          // 缓存写入失败不影响返回
        }
      }
      
      return { data, fromCache: false };
    } catch (error) {
      lastError = error;
      // 如果不是最后一次尝试，等待后重试（指数退避）
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // 所有重试都失败，尝试返回缓存（即使过期）
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const { data } = JSON.parse(cached);
      console.warn('使用过期缓存数据', url);
      return { data, fromCache: true, expired: true };
    }
  } catch (e) {
    // 忽略缓存错误
  }
  
  throw lastError;
}

/* --- 3. 模拟数据库（Movies 初期用于富内容 mock，列表数据将完全来自后端） --- */
const MOVIES_DATA = [
  {
    id: 1, title_cn: "狩猎", title_en: "THE HUNT", director: "Thomas Vinterberg", year: "2012",
    tmdb_rating: 8.1, imdb_rating: 8.3, douban_rating: 9.1, duration: "115m",
    poster: THEATER_IMAGE, status: "showing", genre: "DRAMA", release_date: "2026-01-21",
    curator_note: "本周聚焦于独立影院中的人本主义，讲述那些被主流忽视的声音。",
    synopsis: "一个关于性的谎言如病毒般蔓延，摧毁了一个男人的尊严。曾经受人尊敬的教师卢卡斯突然发现自己成了全村的公敌。",
    cast: [{ name: "Mads Mikkelsen", role: "Lucas", img: "https://i.pravatar.cc/150?u=mads" }, { name: "Thomas Bo Larsen", role: "Theo", img: "https://i.pravatar.cc/150?u=thomas" }],
    cinemas: [
      { id: 1, name: "早稲田松竹", schedule: [{ date: "1/23", times: ["10:40", "15:40", "18:20"] }] },
      { id: 2, name: "K2 Shimokitazawa", schedule: [{ date: "1/23", times: ["18:20", "21:00"] }] }
    ]
  },
  {
    id: 2, title_cn: "穆赫兰道", title_en: "MULHOLLAND DRIVE", director: "David Lynch", year: "2001",
    tmdb_rating: 7.8, imdb_rating: 7.9, douban_rating: 8.4, duration: "147m",
    poster: THEATER_IMAGE, cinema: "早稲田松竹", status: "showing", genre: "MYSTERY",
    curator_note: "大师手笔：洛杉矶霓虹下的超现实梦境。",
    synopsis: "梦境与现实、过去与未来在这里失去界限。这是一场发生在大都会洛杉矶深处的华丽噩梦。",
    cast: [{ name: "Naomi Watts", role: "Betty", img: "https://i.pravatar.cc/150?u=naomi" }],
    cinemas: [{ id: 1, name: "早稲田松竹", schedule: [{ date: "1/23", times: ["13:00", "19:30"] }] }]
  },
  {
    id: 3, title_cn: "蜘蛛侠：纵横宇宙", title_en: "ACROSS THE SPIDER-VERSE", director: "Kemp Powers", year: "2023",
    tmdb_rating: 8.4, imdb_rating: 8.6, douban_rating: 8.5, duration: "140m",
    poster: THEATER_IMAGE, status: "incoming", genre: "ANIMATION", release_date: "2026-01-24",
    synopsis: "迈尔斯回归，一场跨越多元宇宙的奇幻冒险即将开启。",
    cast: [{ name: "Shameik Moore", role: "Miles", img: "https://i.pravatar.cc/150?u=shameik" }],
    cinemas: [{ id: 2, name: "K2 Shimokitazawa", schedule: [{ date: "1/24", times: ["14:00", "19:00"] }] }]
  }
];

// 影院数据不再写死在前端，而是通过 /api/cinemas 从 Go 后端加载。
// 这里保留常量名只是为了文档对照，实际渲染时会使用运行时状态 cinemasState。
const CINEMAS_DATA = [];

// 动态生成未来4周的日期筛选选项
function generateDatesFilter() {
  const dates = [{ id: 'all', label: 'All Dates', sub: 'SHOW ALL' }];
  const today = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  
  // 生成未来28天（4周）的日期选项
  for (let i = 0; i < 28; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const month = monthNames[date.getMonth()];
    const day = date.getDate();
    const dayName = dayNames[date.getDay()];
    
    dates.push({
      id: dateStr,
      label: `${month} ${day}`,
      sub: dayName
    });
  }
  
  return dates;
}

const DATES_FILTER = generateDatesFilter();

/* --- 4. 主程序入口 --- */
export default function App() {
  const [view, setView] = useState('browse'); 
  const [tab, setTab] = useState('showing'); 
  const [archiveTab, setArchiveTab] = useState('watchlist'); 
  const [sortKey, setSortKey] = useState('imdb_rating'); 
  const [filterDate, setFilterDate] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [selectedMovie, setSelectedMovie] = useState(null);
  const [selectedCinema, setSelectedCinema] = useState(null);
  const [cinemaDate, setCinemaDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split('T')[0]; // YYYY-MM-DD
  });
  const [showWelcome, setShowWelcome] = useState(true);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // 监听滚动，显示/隐藏回到顶部按钮
  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 400);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // 监听网络状态
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // 点击外部关闭日期选择器
  useEffect(() => {
    if (!isPickerOpen) return;
    const handleClickOutside = (e) => {
      if (!e.target.closest('.date-picker-container')) {
        setIsPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPickerOpen]);

  // 搜索防抖：用户停止输入 500ms 后再触发搜索
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  /* --- 3.0 影片数据加载模块 ---
   * 职责：
   * - 列表 / 排序 / 日期筛选全部依赖后端 /api/movies 返回的数据
   * - 本地 MOVIES_DATA 仅作为“富内容兜底”（cast / 本地特别文案等）
   */
  const [movies, setMovies] = useState([]);
  const [moviesLoading, setMoviesLoading] = useState(false);
  const [moviesError, setMoviesError] = useState(null);

  /* --- 3.1 影院数据加载模块（来源：Go 后端 /api/cinemas） --- */
  const [cinemasState, setCinemasState] = useState([]);
  const [cinemasLoading, setCinemasLoading] = useState(false);
  const [cinemasError, setCinemasError] = useState(null);

  // --- 状态持久化与想看/已看互斥逻辑 ---
  const [watchlist, setWatchlist] = useState(() => JSON.parse(localStorage.getItem('unseen_wl_vfinal') || '[]'));
  const [history, setHistory] = useState(() => JSON.parse(localStorage.getItem('unseen_hi_vfinal') || '{}'));

  useEffect(() => {
    localStorage.setItem('unseen_wl_vfinal', JSON.stringify(watchlist));
    localStorage.setItem('unseen_hi_vfinal', JSON.stringify(history));
  }, [watchlist, history]);

  // 从后端 API 加载影片基础数据（评分 / 状态 / 上映日期等），
  // 并用 MOVIES_DATA 作为“富内容补充”（通过 title_en 合并 cast / 本地排片示例等）。
  // 根据当前 Browse Tab（Now / Soon）以及 Soon 的日期筛选动态调整查询参数。
  useEffect(() => {
    async function fetchMovies() {
      try {
        setMoviesLoading(true);
        setMoviesError(null);

        const params = new URLSearchParams();
        if (tab === 'showing') {
          params.set('status', 'showing');
          // 按当前排序键请求后端排序结果（IMDB / DOUBAN）
          params.set('sort', sortKey === 'douban_rating' ? 'douban_rating' : 'imdb_rating');
        } else if (tab === 'incoming') {
          params.set('status', 'incoming');
          if (filterDate !== 'all') {
            params.set('date', filterDate);
          }
        }
        // 搜索关键字也传给后端，让后端做模糊匹配（使用防抖后的搜索词）
        if (debouncedSearchTerm) {
          params.set('q', debouncedSearchTerm);
        }
        const qs = params.toString();
        const url = `/api/movies${qs ? `?${qs}` : ''}`;
        const { data, fromCache } = await fetchWithCacheAndRetry(url);
        const apiItems = data.items || [];
        
        // 如果使用缓存数据，在控制台提示（开发时可见）
        if (fromCache && process.env.NODE_ENV === 'development') {
          console.log('📦 使用缓存数据:', url);
        }

        // 以后端列表为主数据源；本地 MOVIES_DATA 仅作为兜底补充。
        const mockByTitleEn = new globalThis.Map(MOVIES_DATA.map(m => [m.title_en, m]));

        const merged = apiItems.map(api => {
          const local = mockByTitleEn.get(api.title_en) || {};
          return {
            // 先铺开后端字段（id / 标题 / 评分 / 状态 / 日期等）
            ...api,
            // 再补充本地 mock 的富内容作为兜底：cast / cinemas / 本地策展文案 / 占位海报
            // 注意：cast 和 cinemas 会在点击详情时从 /api/movies/:id 异步补全，这里只做列表展示的兜底
            cast: local.cast || [],
            cinemas: local.cinemas || [],
            curator_note: api.curator_note || local.curator_note || '',
            poster: api.poster || local.poster || THEATER_IMAGE,
            // 如果后端返回了 runtime，格式化为 "115m" 格式供前端显示
            duration: api.runtime ? `${api.runtime}m` : local.duration || '',
            // 确保 runtime 和 genre 字段也传递下去
            runtime: api.runtime || 0,
            genre: api.genre || local.genre || '',
          };
        });

        setMovies(merged);
      } catch (err) {
        console.error('加载影片数据失败', err);
        setMoviesError('无法加载影片数据');
        // 失败时仍然可以回退到本地 mock，保证 UI 不至于完全空白。
        setMovies(MOVIES_DATA);
      } finally {
        setMoviesLoading(false);
      }
    }
    fetchMovies();
  }, [tab, filterDate, sortKey, debouncedSearchTerm]);

  // 从后端 API 加载影院列表，用于地图 Marker 与影院列表视图。
  useEffect(() => {
    async function fetchCinemas() {
      try {
        setCinemasLoading(true);
        setCinemasError(null);
        // 使用相对路径，交由 Vite devServer 代理到 Go 后端，避免 CORS 问题
        const { data, fromCache } = await fetchWithCacheAndRetry('/api/cinemas');
        setCinemasState(data.items || []);
        
        // 如果使用缓存数据，在控制台提示（开发时可见）
        if (fromCache && process.env.NODE_ENV === 'development') {
          console.log('📦 使用缓存数据: /api/cinemas');
        }
      } catch (err) {
        console.error('加载影院数据失败', err);
        setCinemasError('无法加载影院数据');
      } finally {
        setCinemasLoading(false);
      }
    }
    fetchCinemas();
  }, []);

  const handleCheckIn = (movie, cinemaName, time) => {
    setHistory(prev => ({ ...prev, [movie.id]: { cinema: cinemaName, time: time, ts: Date.now() } }));
    setWatchlist(prev => prev.filter(id => id !== movie.id)); // 核心：标记已看自动从想看中移除
  };

  /* --- 4.1 影片详情打开逻辑（点击卡片 -> 先展示本地数据，再异步补全后端详情） --- */
  const handleOpenMovie = async (movie) => {
    // 先用当前内存中的 movie 打开详情，保证 UI 秒级响应。
    setSelectedMovie(movie);
    try {
      const { data: detail } = await fetchWithCacheAndRetry(`/api/movies/${movie.id}`);
      setSelectedMovie(prev => {
        const base = prev || movie;
        // 使用后端返回字段覆盖评分 / 文案 / 排片信息，但保留本地 mock 的 cast 等富内容作为兜底。
        return {
          ...base,
          ...detail,
          // 评分字段显式合并，避免不同入口导致丢失
          imdb_rating: (detail && typeof detail.imdb_rating === 'number' && detail.imdb_rating > 0)
            ? detail.imdb_rating
            : (base.imdb_rating || 0),
          douban_rating: (detail && typeof detail.douban_rating === 'number' && detail.douban_rating > 0)
            ? detail.douban_rating
            : (base.douban_rating || 0),
          tmdb_rating: (detail && typeof detail.tmdb_rating === 'number' && detail.tmdb_rating > 0)
            ? detail.tmdb_rating
            : (base.tmdb_rating || 0),
          // 优先使用后端返回的 cast / cinemas，只有后端为空时才用本地 mock 兜底
          cast: detail.cast && detail.cast.length > 0 ? detail.cast : (base.cast || []),
          cinemas: detail.cinemas && detail.cinemas.length > 0 ? detail.cinemas : (base.cinemas || []),
          synopsis: detail.synopsis || base.synopsis || '',
          curator_note: detail.curator_note || base.curator_note || '',
          // 海报优先用后端返回的 poster，如果没有则用兜底图
          poster: detail.poster || base.poster || THEATER_IMAGE,
          // runtime 格式化
          duration: detail.runtime ? `${detail.runtime}m` : base.duration || '',
          // 确保 runtime 字段也传递下去
          runtime: detail.runtime || base.runtime || 0,
          // genre 字段
          genre: detail.genre || base.genre || '',
        };
      });
    } catch (err) {
      console.error('加载影片详情失败', err);
    }
  };

  // --- 综合过滤与排序 ---
  // 注意：后端已经完成了 status / date / sort / search 的过滤和排序，
  // 这里只需要处理 Archive 视图的 watchlist / history 过滤。
  const displayedMovies = useMemo(() => {
    if (view === 'archive') {
      // Archive 视图：按 watchlist 或 history 过滤
      if (archiveTab === 'watchlist') {
        return movies.filter(m => watchlist.includes(m.id));
      } else {
        return movies.filter(m => history[m.id]);
      }
    }
    // Browse 视图：直接使用后端返回的数据（已经按 status / date / sort / search 过滤排序）
    return movies;
  }, [view, archiveTab, watchlist, history, movies]);

  return (
    <div className="min-h-screen bg-[#F5F5F2] text-[#1A2F2B] font-sans flex flex-col md:flex-row overflow-hidden max-w-full">
      <style>{GLOBAL_STYLES}</style>
      
      {/* 5. 侧边栏 (Fixed) */}
      <aside className="hidden md:flex fixed top-0 left-0 w-24 flex-col bg-white border-r border-zinc-200 h-full py-10 items-center justify-between z-50 shrink-0 shadow-sm">
        <h1 className="text-xl font-black rotate-180 [writing-mode:vertical-lr] tracking-widest uppercase opacity-20 text-[#1A2F2B]">Unseen.</h1>
        <nav className="flex flex-col space-y-12">
          <SideLink icon={<Compass size={24}/>} active={view === 'browse'} onClick={() => setView('browse')} />
          <SideLink icon={<User size={24}/>} active={view === 'archive'} onClick={() => setView('archive')} />
          <SideLink icon={<MapPin size={24}/>} active={view === 'cinemas'} onClick={() => setView('cinemas')} />
        </nav>
        <button className="text-zinc-400 hover:text-black transition-colors"><Settings size={22} /></button>
      </aside>

      {/* 6. 主内容区 */}
      <div className="flex-1 flex flex-col min-w-0 w-full md:ml-24 overflow-x-hidden">
        
        <header className={`px-6 md:px-20 pt-10 md:pt-16 pb-8 bg-[#F5F5F2]/90 backdrop-blur-md z-40 border-b border-zinc-100 w-full ${view === 'cinemas' ? 'hidden md:block' : ''}`}>
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 overflow-hidden">
            <div className="flex-1">
              <div className="flex items-center space-x-2 text-[9px] font-black tracking-[0.4em] text-zinc-300 mb-4 uppercase leading-none">
                <div className="w-8 h-[1px] bg-zinc-300" />
                <span>{view === 'browse' ? 'Tokyo Film Curation' : view === 'archive' ? 'Personal Archive' : 'Cinemas Explorer'}</span>
              </div>
              <div className="flex space-x-6 md:space-x-12 items-baseline leading-none flex-wrap">
                {view === 'browse' ? (
                  <div className="flex space-x-6 md:space-x-10">
                    <button onClick={() => setTab('showing')} className={`text-4xl sm:text-6xl md:text-8xl font-black transition-all ${tab === 'showing' ? 'text-[#1A2F2B]' : 'text-zinc-200 hover:text-zinc-300'}`}>Now.</button>
                    <button onClick={() => setTab('incoming')} className={`text-4xl sm:text-6xl md:text-8xl font-black transition-all ${tab === 'incoming' ? 'text-[#1A2F2B]' : 'text-zinc-200 hover:text-zinc-300'}`}>Soon.</button>
                  </div>
                ) : view === 'archive' ? (
                   <h2 className="text-5xl md:text-8xl font-black text-[#1A2F2B] tracking-tighter uppercase leading-none italic">Profile.</h2>
                ) : (
                  <h2 className="text-4xl sm:text-6xl md:text-8xl font-black text-[#1A2F2B] tracking-tighter uppercase leading-none">Theaters.</h2>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-4 bg-white border border-zinc-200 rounded-full px-5 md:px-6 py-2.5 md:py-3 shadow-sm w-full md:w-80 shrink-0">
              <SearchIcon size={18} className={`text-zinc-400 ${searchTerm !== debouncedSearchTerm ? 'animate-pulse' : ''}`} />
              <input type="text" placeholder="Search curated..." className="bg-transparent border-none outline-none text-sm font-bold w-full text-[#1A2F2B]" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
              {searchTerm !== debouncedSearchTerm && (
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} className="w-4 h-4 border-2 border-[#C5A059] border-t-transparent rounded-full" />
              )}
            </div>
          </div>
        </header>

        {/* 6.5 离线状态提示条 */}
        <AnimatePresence>
          {!isOnline && (
            <motion.div
              initial={{ y: -50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -50, opacity: 0 }}
              className="bg-amber-500 text-white px-6 md:px-20 py-3 text-center text-sm font-bold flex items-center justify-center gap-2"
            >
              <AlertCircle size={16} />
              <span>当前处于离线状态，正在使用缓存数据</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 7. 工具栏：排序与 Soon 模式日期筛选 */}
        {view === 'browse' && (
          <div className="px-8 md:px-20 py-8 flex flex-wrap items-center gap-8">
            {tab === 'showing' ? (
              <div className="flex p-1 bg-white rounded-full border border-zinc-200 shadow-sm">
                <SortBtn active={sortKey === 'imdb_rating'} label="BY IMDB" onClick={() => setSortKey('imdb_rating')} />
                <SortBtn active={sortKey === 'douban_rating'} label="BY DOUBAN" onClick={() => setSortKey('douban_rating')} />
              </div>
            ) : (
              <div className="relative date-picker-container">
                <button onClick={() => setIsPickerOpen(!isPickerOpen)} className="flex items-center space-x-3 px-5 py-2.5 bg-white rounded-full border border-zinc-200 shadow-sm transition-all active:scale-95 hover:border-[#1A2F2B]">
                  <Calendar size={14} className="text-[#1A2F2B]" />
                  <div className="flex flex-col items-start">
                    <span className="text-[10px] font-black tracking-widest uppercase">{DATES_FILTER.find(d => d.id === filterDate)?.label || 'All Dates'}</span>
                    {filterDate !== 'all' && DATES_FILTER.find(d => d.id === filterDate)?.sub && (
                      <span className="text-[8px] text-zinc-400 uppercase">{DATES_FILTER.find(d => d.id === filterDate).sub}</span>
                    )}
                  </div>
                  <ChevronDown size={14} className={`text-zinc-400 transition-transform ${isPickerOpen ? 'rotate-180' : ''}`} />
                </button>
                <AnimatePresence>
                  {isPickerOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="absolute top-14 left-0 w-72 bg-[#1A2F2B] text-white rounded-3xl shadow-2xl p-3 z-50 max-h-[400px] overflow-y-auto no-scrollbar"
                    >
                      {DATES_FILTER.map(d => (
                        <button
                          key={d.id}
                          onClick={() => {
                            setFilterDate(d.id);
                            setIsPickerOpen(false);
                          }}
                          className={`w-full flex items-center justify-between p-4 hover:bg-white/10 rounded-2xl text-left transition-colors ${
                            filterDate === d.id ? 'bg-white/10' : ''
                          }`}
                        >
                          <div className="flex flex-col items-start">
                            <span className="font-black text-xs uppercase tracking-wider">{d.label}</span>
                            {d.sub && <span className="text-[9px] text-zinc-400 uppercase mt-0.5">{d.sub}</span>}
                          </div>
                          {filterDate === d.id && <Check size={16} className="text-[#C5A059] shrink-0" />}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        )}

        <main className={`w-full ${view === 'cinemas' ? 'p-0 h-[calc(100vh-80px)] md:h-[calc(100vh-120px)]' : 'px-8 md:px-20 py-12 pb-40'}`}>
          <AnimatePresence mode="wait">
            {view === 'archive' ? (
                <ArchivePageView key="archive" history={history} watchlist={watchlist} movies={displayedMovies} onSelect={handleOpenMovie} archiveTab={archiveTab} setArchiveTab={setArchiveTab} />
            ) : view === 'cinemas' ? (
                <CinemaView
                  key="cinemas"
                  selectedCinema={selectedCinema}
                  onSelectCinema={setSelectedCinema}
                  cinemaDate={cinemaDate}
                  setCinemaDate={setCinemaDate}
                  history={history}
                  cinemas={cinemasState}
                  loading={cinemasLoading}
                  error={cinemasError}
                />
            ) : (
              <motion.div key="browse" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                {moviesLoading ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-12">
                    {[...Array(8)].map((_, i) => (
                      <MovieCardSkeleton key={i} />
                    ))}
                  </div>
                ) : moviesError ? (
                  <div className="flex items-center justify-center py-20">
                    <p className="text-red-500 text-sm">{moviesError}</p>
                  </div>
                ) : displayedMovies.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 space-y-4">
                    {debouncedSearchTerm ? (
                      <>
                        <SearchIcon size={48} className="text-zinc-300" />
                        <p className="text-zinc-400 text-sm">未找到匹配 "{debouncedSearchTerm}" 的影片</p>
                        <button onClick={() => { setSearchTerm(''); setDebouncedSearchTerm(''); }} className="text-xs text-zinc-500 hover:text-[#1A2F2B] underline">清除搜索</button>
                      </>
                    ) : (
                      <>
                        <Film size={48} className="text-zinc-300" />
                        <p className="text-zinc-400 text-sm">暂无影片数据</p>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-12">
                    {displayedMovies.map(movie => <MovieCard key={movie.id} movie={movie} tab={tab} sortKey={sortKey} isFav={watchlist.includes(movie.id)} isWatched={!!history[movie.id]} onClick={() => handleOpenMovie(movie)} />)}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* --- 8. 回到顶部按钮 --- */}
      <AnimatePresence>
        {showScrollTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="fixed bottom-24 md:bottom-10 right-6 md:right-10 p-4 bg-[#1A2F2B] text-white rounded-full shadow-2xl hover:bg-[#C5A059] transition-colors z-[90]"
            aria-label="回到顶部"
          >
            <ArrowUp size={20} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* --- 9. 移动端底部导航 --- */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-20 bg-white/80 backdrop-blur-2xl border-t border-zinc-100 flex items-center justify-around px-8 pb-6 z-[80]">
        <button onClick={() => setView('browse')} className={`p-3 rounded-2xl ${view === 'browse' ? 'bg-[#1A2F2B] text-white shadow-lg' : 'text-zinc-400'}`}><Compass size={24}/></button>
        <button onClick={() => setView('archive')} className={`p-3 rounded-2xl ${view === 'archive' ? 'bg-[#1A2F2B] text-white shadow-lg' : 'text-zinc-400'}`}><User size={24}/></button>
        <button onClick={() => setView('cinemas')} className={`p-3 rounded-2xl ${view === 'cinemas' ? 'bg-[#1A2F2B] text-white shadow-lg' : 'text-zinc-400'}`}><MapPin size={24}/></button>
      </nav>

      <AnimatePresence>
        {selectedMovie && <DetailView movie={selectedMovie} isFav={watchlist.includes(selectedMovie.id)} watchedInfo={history[selectedMovie.id]} onToggleFav={() => {if(!history[selectedMovie.id]) setWatchlist(prev => prev.includes(selectedMovie.id) ? prev.filter(i => i !== selectedMovie.id) : [...prev, selectedMovie.id])}} onConfirmWatched={(cinemaName, time) => handleCheckIn(selectedMovie, cinemaName, time)} onRemoveHistory={() => { const newH = { ...history }; delete newH[selectedMovie.id]; setHistory(newH); }} onClose={() => setSelectedMovie(null)} />}
        {showWelcome && displayedMovies[0] && <WelcomeModal movie={displayedMovies[0]} onClose={() => setShowWelcome(false)} />}
      </AnimatePresence>
    </div>
  );
}

/* --- 模块：影院视图 (核心补全：手机端点击即自动拉起抽屉 + 从后端加载数据) --- */
function CinemaView({ selectedCinema, onSelectCinema, cinemaDate, setCinemaDate, history, cinemas, loading, error }) {
  const [viewport, setViewport] = useState({ latitude: 35.6895, longitude: 139.6917, zoom: 12, pitch: 45 });
  const [sheetState, setSheetState] = useState('peek');
  const isMobile = window.innerWidth < 768;

  const sheetVariants = {
    peek: { y: isMobile ? '75vh' : '0' },
    full: { y: isMobile ? '10vh' : '0' }
  };

  return (
    <div className="relative w-full h-full overflow-hidden flex flex-col md:flex-row bg-[#0a0a0b]">
      {/* 1. Map 容器：确保 100% 高度显示 */}
      <div className="absolute inset-0 md:relative md:flex-[1.5] bg-[#0a0a0b] md:rounded-[3.5rem] md:m-6 overflow-hidden border border-white/5 shadow-inner z-0">
        <MapGL {...viewport} onMove={evt => setViewport(evt.viewState)} mapStyle="mapbox://styles/mapbox/navigation-night-v1" mapboxAccessToken={MAPBOX_TOKEN} antialias={true} style={{ width: '100%', height: '100%' }}>
          {cinemas.map(c => (
            <Marker
              key={c.id}
              latitude={c.lat}
              longitude={c.lng}
              anchor="bottom"
              onClick={async (e) => {
                e.originalEvent.stopPropagation();
                // 先用基础数据打开 bottom sheet 和地图定位
                onSelectCinema(c);
                if (isMobile) setSheetState('full');
                setViewport({ ...viewport, latitude: c.lat, longitude: c.lng, zoom: 14, transitionDuration: 1000 });
                // 再异步请求后端详情，补全 daily_movies 等字段
                try {
                  const { data: full } = await fetchWithCacheAndRetry(`/api/cinemas/${c.id}?date=${cinemaDate}`);
                  onSelectCinema(full);
                } catch (err) {
                  console.error('加载影院详情失败', err);
                }
              }}
            >
              <div className="marker-glow cursor-pointer">
                <div className={`p-2.5 rounded-full shadow-2xl transition-all ${selectedCinema?.id === c.id ? 'bg-[#C5A059] text-black scale-125' : 'bg-[#1A2F2B] text-white hover:bg-[#C5A059]'}`}><Film size={18}/></div>
              </div>
            </Marker>
          ))}
          <NavigationControl position="bottom-right" />
        </MapGL>
      </div>

      {/* 2. 详情抽屉 (Bottom Sheet) */}
      <motion.div 
        drag={isMobile ? "y" : false} dragConstraints={{ top: 0, bottom: 800 }}
        onDragEnd={(e, info) => { if (info.offset.y < -50) setSheetState('full'); if (info.offset.y > 50) setSheetState('peek'); }}
        variants={sheetVariants} initial="peek" animate={selectedCinema ? (isMobile ? sheetState : 'peek') : 'peek'} transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className={`fixed bottom-0 left-0 right-0 md:relative md:bottom-auto md:translate-y-0 md:w-[550px] bg-white rounded-t-[3rem] md:rounded-[3.5rem] shadow-2xl border border-zinc-100 z-[70] h-[95vh] md:h-full md:my-6 md:mr-6 flex flex-col transition-all duration-300`}
      >
        <div className="md:hidden w-12 h-1.5 bg-zinc-200 rounded-full mx-auto mt-4 mb-6 shrink-0 cursor-grab active:cursor-grabbing" />
        <div className="flex-1 overflow-y-auto no-scrollbar px-8 md:px-12 pb-32 pt-4">
          <AnimatePresence mode="wait">
            {selectedCinema ? (
              <motion.div key="cin_detail" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-10 pt-4">
                 <button onClick={() => {onSelectCinema(null); setSheetState('peek');}} className="flex items-center space-x-2 text-zinc-400 font-black text-[10px] tracking-widest uppercase hover:text-black transition-colors"><ArrowRight className="rotate-180" size={14}/> Back</button>
                 <div className="aspect-video rounded-[2.5rem] overflow-hidden shadow-2xl border border-zinc-100"><img src={THEATER_IMAGE} className="w-full h-full object-cover" alt="" /></div>
                 <h3 className="text-5xl font-black text-[#1A2F2B] tracking-tighter uppercase leading-none">{selectedCinema.name}</h3>
                 <div className="flex gap-4 pt-4"><a href={`https://www.google.com/maps/dir/?api=1&destination=${selectedCinema.lat},${selectedCinema.lng}`} target="_blank" className="flex-1 bg-zinc-900 text-white h-16 rounded-2xl font-black text-xs tracking-widest flex items-center justify-center uppercase shadow-xl shadow-zinc-200">Navigate</a><a href={selectedCinema.website} target="_blank" className="flex-1 border border-zinc-200 text-[#1A2F2B] h-16 rounded-2xl font-black text-xs tracking-widest flex items-center justify-center uppercase hover:bg-zinc-50 transition-colors">Website</a></div>
                 <p className="text-sm text-zinc-500 leading-relaxed italic border-l-2 border-zinc-100 pl-6 italic">“{selectedCinema.desc}”</p>
                 <div className="pt-8 border-t border-zinc-100 space-y-12">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[10px] font-black text-zinc-300 tracking-[0.4em] uppercase flex items-center gap-2"><Clock size={12}/> Daily Schedule</h4>
                      <input
                        type="date"
                        value={cinemaDate}
                        onChange={async (e) => {
                          const newDate = e.target.value;
                          setCinemaDate(newDate);
                          if (selectedCinema?.id) {
                            try {
                              const { data: full } = await fetchWithCacheAndRetry(`/api/cinemas/${selectedCinema.id}?date=${newDate}`);
                              setSelectedCinema(full);
                            } catch (err) {
                              console.error('加载影院详情失败', err);
                            }
                          }
                        }}
                        min={new Date().toISOString().split('T')[0]}
                        className="px-4 py-2 rounded-xl border border-zinc-200 text-sm font-black text-[#1A2F2B] bg-white focus:outline-none focus:ring-2 focus:ring-[#C5A059] focus:border-transparent"
                      />
                    </div>
                    {(selectedCinema.daily_movies || []).length === 0 ? (
                      <p className="text-sm text-zinc-400 italic">该日期暂无排片</p>
                    ) : (
                      (selectedCinema.daily_movies || []).map(m => (
                        <div key={m.id} className="space-y-6">
                          <div className="flex justify-between items-baseline"><p className="font-black text-xl text-[#1A2F2B] uppercase tracking-tighter leading-none">{m.title}</p><span className="text-xs font-black italic text-[#B8860B]">★ {m.rating}</span></div>
                          <div className="flex flex-wrap gap-2">
                            {m.times.map(t => {
                              const isWatchedThis = history[m.id]?.time === t && history[m.id]?.cinema === selectedCinema.name;
                              return <div key={t} className={`px-6 py-3 rounded-2xl border text-sm font-black transition-all shadow-sm flex items-center gap-2 ${isWatchedThis ? 'bg-[#10b981] border-[#10b981] text-white shadow-green-100' : 'bg-zinc-50 border-zinc-100 text-[#1A2F2B] hover:bg-[#1A2F2B] hover:text-white'}`}>{t} {isWatchedThis && <Check size={14}/>}</div>;
                            })}
                          </div>
                        </div>
                      ))
                    )}
                 </div>
              </motion.div>
            ) : (
              <motion.div key="cin_list" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-10 pt-4 text-left">
                <h2 className="text-5xl font-black text-[#1A2F2B] tracking-tighter uppercase leading-none">Theaters.</h2>
                {loading && <p className="text-sm text-zinc-400">Loading cinemas…</p>}
                {error && !loading && <p className="text-sm text-red-500">{error}</p>}
                <div className="space-y-4">
                  {cinemas.map(c => (
                    <div
                      key={c.id}
                      onClick={async () => {
                        onSelectCinema(c);
                        if (isMobile) setSheetState('full');
                        setViewport({ ...viewport, latitude: c.lat, longitude: c.lng, zoom: 14 });
                        try {
                          const { data: full } = await fetchWithCacheAndRetry(`/api/cinemas/${c.id}?date=${cinemaDate}`);
                          setSelectedCinema(full);
                        } catch (e) {
                          console.error('加载影院详情失败', e);
                        }
                      }}
                      className="p-8 bg-zinc-50 rounded-[2.5rem] border border-transparent hover:border-[#1A2F2B] hover:bg-white hover:shadow-xl transition-all cursor-pointer flex justify-between items-center group"
                    >
                      <div className="flex-1 font-sans">
                        <p className="font-black text-[#1A2F2B] uppercase text-lg leading-none mb-1">{c.name}</p>
                        <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">{c.district}</p>
                      </div>
                      <ChevronRight size={18} className="text-zinc-200 group-hover:text-[#1A2F2B]" />
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

// --- 模块：电影详情页 (补全主演头像滚动) ---
function DetailView({ movie, isFav, watchedInfo, onToggleFav, onConfirmWatched, onRemoveHistory, onClose }) {
  const [activeCinIdx, setActiveCinIdx] = useState(0);
  const [isPicking, setIsPicking] = useState(false);
  const [confirmingTime, setConfirmingTime] = useState(null);
  const currentCinema = movie.cinemas && movie.cinemas.length > 0 ? movie.cinemas[activeCinIdx] : null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-white overflow-y-auto no-scrollbar">
      <div className="fixed top-6 right-6 md:top-10 md:right-10 z-[110] flex gap-3">
        {!watchedInfo && <button onClick={onToggleFav} className={`p-4 rounded-full border shadow-xl bg-white transition-all ${isFav ? 'bg-[#1A2F2B] text-[#C5A059] border-[#1A2F2B]' : 'text-zinc-400'}`}><Heart fill={isFav ? "currentColor" : "none"} size={22}/></button>}
        <button onClick={() => watchedInfo ? onRemoveHistory() : setIsPicking(!isPicking)} className={`p-4 rounded-full border shadow-xl bg-white transition-all ${watchedInfo ? 'bg-[#10b981] text-white border-[#10b981]' : isPicking ? 'bg-[#1A2F2B] text-white border-[#1A2F2B] scale-110' : 'bg-white text-zinc-400'}`}><Eye fill={watchedInfo || isPicking ? "currentColor" : "none"} size={22}/></button>
        <button onClick={onClose} className="p-4 bg-zinc-100 hover:bg-black hover:text-white rounded-full border border-zinc-200 shadow-xl transition-all"><X size={24}/></button>
      </div>
      <div className="flex flex-col lg:flex-row min-h-screen">
        <div className="w-full lg:w-[45%] h-[45vh] lg:h-screen lg:sticky lg:top-0 overflow-hidden bg-zinc-50 border-r border-zinc-100"><img src={movie.poster || THEATER_IMAGE} className="w-full h-full object-cover" alt={movie.title_cn} /></div>
        <div className="flex-1 px-8 md:px-24 py-12 md:py-20 bg-white flex flex-col justify-center">
          <div className="max-w-2xl relative">
            {watchedInfo && <motion.div initial={{ y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="mb-12 bg-[#10b981]/10 border border-[#10b981]/20 p-6 rounded-[2rem] flex items-center justify-between text-[#10b981] font-bold shadow-sm font-sans"><div className="flex items-center gap-4 text-emerald-500 font-sans font-bold uppercase"><CheckCircle2 /><span>Watched @ {watchedInfo.cinema} {watchedInfo.time}</span></div><button onClick={onRemoveHistory} className="text-[10px] uppercase underline opacity-60">撤销</button></motion.div>}
            <h2 className="text-6xl md:text-9xl font-black tracking-tighter text-[#1A2F2B] mb-8 leading-none italic">{movie.title_cn}.</h2>
            <div className="flex flex-wrap gap-3 mb-10">
              {movie.director && <InfoChip label="Dir." value={movie.director} />}
              {movie.imdb_rating > 0 && <InfoChip label="IMDb" value={movie.imdb_rating} />}
              {movie.douban_rating > 0 && <InfoChip label="豆瓣" value={movie.douban_rating} />}
              {movie.runtime > 0 && <InfoChip label="时长" value={`${movie.runtime}m`} />}
              {movie.genre && <InfoChip label="类型" value={movie.genre} />}
            </div>
            
            {/* 主演头像回归 */}
            <section className="mb-16">
              <h4 className="text-[10px] font-black text-zinc-300 tracking-[0.4em] uppercase mb-8">Personnel</h4>
              <div className="flex space-x-8 overflow-x-auto no-scrollbar">
                {movie.cast?.map((c, i) => (
                  <div key={i} className="shrink-0 text-center space-y-3"><img src={c.img} className="w-20 h-20 rounded-full object-cover grayscale shadow-lg border border-zinc-100" /><p className="text-[10px] font-black text-zinc-600">{c.name}</p></div>
                ))}
              </div>
            </section>

            {/* 剧情简介 */}
            {movie.synopsis && (
              <section className="mb-16">
                <h4 className="text-[10px] font-black text-zinc-300 tracking-[0.4em] uppercase mb-4">Synopsis</h4>
                <p className="text-sm text-zinc-600 leading-relaxed">{movie.synopsis}</p>
              </section>
            )}

            {/* 策展文案 */}
            {movie.curator_note && (
              <section className="mb-16">
                <h4 className="text-[10px] font-black text-zinc-300 tracking-[0.4em] uppercase mb-4">Curator Note</h4>
                <p className="text-sm text-zinc-500 italic leading-relaxed">"{movie.curator_note}"</p>
              </section>
            )}

            <div className="mb-10"><h4 className="text-[10px] font-black text-zinc-300 tracking-[0.4em] uppercase mb-4">Select Cinema</h4><div className="flex flex-wrap gap-3">{(movie.cinemas || []).map((c,i) => <button key={c.id} onClick={()=>setActiveCinIdx(i)} className={`px-6 py-3 rounded-full border text-[10px] font-black tracking-widest transition-all ${activeCinIdx===i ? 'bg-[#1A2F2B] text-white border-[#1A2F2B]' : 'bg-white text-zinc-400 border-zinc-100 hover:border-zinc-300'}`}>{c.name}</button>)}</div></div>
            <section className="mb-20">
              <h4 className={`text-[10px] font-black uppercase tracking-[0.4em] mb-10 flex items-center gap-2 ${isPicking ? 'text-[#10b981]' : 'text-zinc-400'}`}>
                <Clock size={14}/> {isPicking ? 'SELECT A SESSION' : 'SCHEDULE'}
              </h4>
              {currentCinema && currentCinema.schedule && currentCinema.schedule.length > 0 ? (
                <div className="space-y-8">
                  {currentCinema.schedule.map((sched, schedIdx) => (
                    <div key={schedIdx} className="space-y-4">
                      <h5 className="text-xs font-black text-zinc-400 uppercase tracking-widest">{sched.date}</h5>
                      <div className="grid grid-cols-2 gap-4">
                        {sched.times && sched.times.length > 0 ? sched.times.map((time, i) => {
                          const isActive = watchedInfo?.time === time && watchedInfo?.cinema === currentCinema.name;
                          return (
                            <button
                              key={i}
                              onClick={() => isPicking && setConfirmingTime(time)}
                              className={`flex items-center justify-between p-7 rounded-[2.5rem] border transition-all ${
                                isActive
                                  ? 'bg-[#10b981] border-[#10b981] text-white shadow-xl shadow-green-200'
                                  : isPicking
                                    ? 'border-[#10b981]/50 border-dashed animate-pulse text-[#10b981]'
                                    : 'bg-zinc-50 border-zinc-100 hover:border-[#1A2F2B]'
                              }`}
                            >
                              <p className="text-3xl font-black">{time}</p>
                              {isActive ? <CheckCircle2 size={20}/> : <Ticket size={16} className="opacity-20" />}
                            </button>
                          );
                        }) : <p className="text-zinc-400 text-sm col-span-2">该日期暂无场次</p>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-400 text-sm">暂无排片信息</p>
              )}
            </section>
          </div>
        </div>
      </div>
      <AnimatePresence>{confirmingTime && <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6" onClick={()=>setConfirmingTime(null)}><motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} onClick={e=>e.stopPropagation()} className="bg-white p-12 rounded-[3.5rem] max-w-sm w-full text-center shadow-3xl border border-white/20"><AlertCircle size={48} className="text-[#10b981] mx-auto mb-6" /><h3 className="text-xl font-black mb-2 uppercase tracking-tighter">Check-in?</h3><p className="text-zinc-500 text-sm mb-10 italic leading-relaxed text-center w-full">确认在观看了 {confirmingTime} 场次？</p><div className="flex gap-4"><button onClick={()=>setConfirmingTime(null)} className="flex-1 h-16 rounded-2xl font-bold text-zinc-400 bg-zinc-50 uppercase">Cancel</button><button onClick={()=>{onConfirmWatched(currentCinema.name, confirmingTime);setConfirmingTime(null);setIsPicking(false);}} className="flex-1 h-16 rounded-2xl font-bold bg-[#10b981] text-white uppercase shadow-lg">Confirm</button></div></motion.div></div>}</AnimatePresence>
    </motion.div>
  );
}

// --- 组件：Archive ---
function ArchivePageView({ history, watchlist, movies, onSelect, archiveTab, setArchiveTab }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-5xl space-y-10 pb-20">
      <div className="bg-[#1A2F2B] p-10 rounded-[3rem] text-white flex items-center justify-between shadow-2xl relative overflow-hidden font-sans font-sans"><div className="flex items-center space-x-8 z-10 font-sans"><div className="w-20 h-20 rounded-full bg-[#F5F5F2] flex items-center justify-center text-3xl font-black text-[#1A2F2B]">JL</div><div><h2 className="text-3xl font-black tracking-tight uppercase italic leading-none mb-1">jiajian liang</h2><p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mt-1 tracking-widest leading-none font-sans uppercase">Cinephile Elite</p></div></div><LogOut className="text-white/20 hover:text-white transition-colors cursor-pointer z-10" /></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6"><StatCard active={archiveTab === 'watchlist'} onClick={() => setArchiveTab('watchlist')} icon={<Heart fill={archiveTab === 'watchlist' ? "#C5A059" : "none"} className={archiveTab === 'watchlist' ? "text-[#C5A059]" : "text-zinc-500"}/>} label="想看" count={watchlist.length} sub="WATCHLIST" color="text-[#C5A059]" /><StatCard active={archiveTab === 'history'} onClick={() => setArchiveTab('history')} icon={<Eye fill={archiveTab === 'history' ? "#10b981" : "none"} className={archiveTab === 'history' ? "text-[#10b981]" : "text-zinc-500"}/>} label="已看" count={Object.keys(history).length} sub="HISTORY" color="text-[#10b981]" /></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-12 pt-10 border-t border-zinc-200">{movies.map(movie => <MovieCard key={movie.id} movie={movie} isFav={watchlist.includes(movie.id)} isWatched={!!history[movie.id]} onClick={() => onSelect(movie)} />)}</div>
    </motion.div>
  );
}

// --- 其余基础组件 ---
// --- 组件：电影卡片骨架屏（加载状态） ---
function MovieCardSkeleton() {
  return (
    <div className="flex flex-col w-full animate-pulse">
      <div className="relative aspect-[3.2/4.5] w-full rounded-[2.2rem] overflow-hidden mb-6 bg-gradient-to-br from-zinc-200 via-zinc-100 to-zinc-200 shadow-2xl" />
      <div className="px-1 space-y-3">
        <div className="h-6 bg-zinc-200 rounded-lg w-3/4" />
        <div className="h-4 bg-zinc-100 rounded-lg w-1/2" />
        <div className="pt-4 border-t border-zinc-100 flex items-center justify-between">
          <div className="h-3 bg-zinc-100 rounded w-24" />
          <div className="h-3 bg-zinc-100 rounded w-12" />
        </div>
      </div>
    </div>
  );
}

function MovieCard({ movie, tab, sortKey = 'imdb_rating', isFav, isWatched, onClick }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  // 影院标签策略：
  // - 后端优先：cinema_count / primary_cinema_name
  // - 若无后端数据，则回退到本地 mock 的 cinemas 数组
  const cinemaCountFromApi = typeof movie.cinema_count === 'number' ? movie.cinema_count : 0;
  const cinemasFromMock = Array.isArray(movie.cinemas) ? movie.cinemas : [];
  const cinemaCount = cinemaCountFromApi > 0 ? cinemaCountFromApi : cinemasFromMock.length;
  let cinemaLabel = "THEATER";
  if (cinemaCount > 1) {
    cinemaLabel = `${cinemaCount} CINEMAS`;
  } else if (cinemaCount === 1) {
    cinemaLabel = movie.primary_cinema_name || cinemasFromMock[0]?.name || "THEATER";
  } else {
    cinemaLabel = movie.primary_cinema_name || cinemasFromMock[0]?.name || "THEATER";
  }

  const imageSrc = movie.poster || THEATER_IMAGE;
  const isDoubanSort = sortKey === 'douban_rating';
  const primaryScore = isDoubanSort ? movie.douban_rating : movie.imdb_rating;
  const fallbackScore = isDoubanSort ? movie.imdb_rating || movie.tmdb_rating : movie.douban_rating || movie.tmdb_rating;
  const displayScore = primaryScore > 0 ? primaryScore : (fallbackScore > 0 ? fallbackScore : 0);
  
  return (
    <motion.div layout className="cursor-pointer group flex flex-col w-full font-sans" onClick={onClick}>
      <div className="relative aspect-[3.2/4.5] w-full rounded-[2.2rem] overflow-hidden mb-6 bg-zinc-200 shadow-2xl shadow-zinc-200/50 transition-all group-hover:shadow-zinc-300">
        {!imageLoaded && !imageError && (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-200 via-zinc-100 to-zinc-200 animate-pulse" />
        )}
        <img 
          src={imageError ? THEATER_IMAGE : imageSrc} 
          className={`w-full h-full object-cover transition-all duration-500 group-hover:scale-110 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
          alt={movie.title_cn}
          loading="lazy"
          onLoad={() => setImageLoaded(true)}
          onError={() => {
            if (!imageError && imageSrc !== THEATER_IMAGE) {
              // 如果原始图片加载失败且不是占位图，则切换到占位图
              setImageError(true);
              setImageLoaded(false);
            } else {
              // 占位图加载成功或已经是占位图
              setImageLoaded(true);
            }
          }}
        />
        <div className="absolute top-5 left-5 flex flex-col space-y-2">
          {isFav && <div className="p-2.5 rounded-full bg-[#1A2F2B] text-[#C5A059] shadow-xl border border-white/20"><Heart size={14} fill="currentColor" /></div>}
          {isWatched && <div className="p-2.5 rounded-full bg-[#10b981] text-white shadow-xl border border-white/20"><Eye size={14} fill="currentColor" /></div>}
        </div>
        <div className="absolute top-5 right-5 bg-[#1A2F2B] text-white px-2.5 py-1.5 rounded-xl border border-white/10 shadow-2xl flex items-center gap-1">
          <Star size={10} fill="#C5A059" className="text-[#C5A059]" />
          <span className="text-[10px] font-black italic">
            {displayScore > 0 ? displayScore.toFixed(1) : '--'}
          </span>
        </div>
        {tab === 'incoming' && (
          <div className="absolute bottom-6 left-6 bg-white px-4 py-2 rounded-2xl shadow-xl border border-zinc-100 font-black text-[10px] uppercase tracking-tighter whitespace-nowrap">
            {(movie.earliest_schedule_date || movie.release_date || '').split('-').slice(1).join(' / ')}
          </div>
        )}
      </div>
      <div className="px-1 font-sans"><h3 className="text-xl font-black tracking-tighter text-[#1A2F2B] mb-2 leading-none group-hover:text-zinc-500 transition-colors uppercase truncate">{movie.title_cn}</h3><p className="text-[10px] font-bold text-zinc-400 italic mb-4 truncate leading-none font-sans">Dir. {movie.director}</p><div className="flex items-center justify-between text-[9px] font-black text-zinc-300 uppercase tracking-widest pt-4 border-t border-zinc-100"><span>@ {cinemaLabel}</span><span>{movie.year}</span></div></div>
    </motion.div>
  );
}
function StatCard({ icon, label, count, sub, color, active, onClick }) { return <div onClick={onClick} className={`p-10 rounded-[3rem] border transition-all cursor-pointer flex items-center justify-between shadow-sm group ${active ? 'bg-white border-[#1A2F2B] scale-[1.02] shadow-xl' : 'bg-white border-transparent hover:border-zinc-200 opacity-60'}`}><div className="flex items-center space-x-6"><div className={`p-4 rounded-2xl ${active ? 'bg-zinc-50' : 'bg-zinc-50/50'}`}>{icon}</div><div><p className="text-[10px] font-black text-zinc-300 uppercase leading-none mb-2 tracking-widest font-sans uppercase">{sub}</p><p className={`text-2xl font-black ${active ? color : 'text-zinc-500'}`}>{label}</p></div></div><span className={`text-5xl font-black tracking-tighter transition-colors ${active ? 'text-[#1A2F2B]' : 'text-zinc-100 group-hover:text-zinc-300'}`}>{count}</span></div>; }
function SideLink({ icon, active, onClick }) { return <div onClick={onClick} className={`p-4 rounded-2xl cursor-pointer transition-all ${active ? 'bg-[#1A2F2B] text-white shadow-xl shadow-[#1A2F2B]/30' : 'text-zinc-500 hover:text-[#1A2F2B]'}`}>{icon}</div>; }
function SortBtn({ active, label, onClick }) { return <button onClick={onClick} className={`px-6 md:px-8 py-2.5 rounded-full text-[10px] font-black tracking-widest transition-all ${active ? 'bg-[#1A2F2B] text-white shadow-xl shadow-[#1A2F2B]/20' : 'text-zinc-400 hover:text-zinc-600'}`}>{label}</button>; }
function InfoChip({ label, value }) { return <div className="px-5 py-2.5 bg-zinc-50 border border-zinc-100 rounded-2xl text-[9px] font-black uppercase tracking-widest flex gap-3 shadow-sm font-sans font-bold"><span className="text-zinc-400">{label}</span><span className="text-[#1A2F2B] font-bold">{value}</span></div>; }
function WelcomeModal({ movie, onClose }) { return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[200] bg-[#1A2F2B]/20 backdrop-blur-xl flex items-center justify-center p-6"><motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] overflow-hidden shadow-3xl max-w-5xl w-full grid grid-cols-1 md:grid-cols-2"><div className="h-[25vh] md:h-auto"><img src={THEATER_IMAGE} className="w-full h-full object-cover" alt="" /></div><div className="p-8 md:p-16 flex flex-col justify-center text-[#1A2F2B]"><span className="bg-[#1A2F2B] text-white px-3 py-1 rounded text-[9px] font-black uppercase mb-6 w-fit tracking-widest font-sans font-bold">Spotlight</span><h3 className="text-3xl md:text-4xl font-black italic tracking-tighter mb-4 leading-none uppercase">Curation Archive.</h3><p className="text-zinc-500 text-sm italic mb-10 leading-relaxed font-sans">“{movie.curator_note}”</p><button onClick={onClose} className="w-full bg-[#1A2F2B] text-white h-16 rounded-2xl font-black text-xs tracking-widest uppercase shadow-xl font-sans">Enter</button></div></motion.div></motion.div>; }