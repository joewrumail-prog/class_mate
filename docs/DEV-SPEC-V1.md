# classmate Web MVP 开发 Spec v1.0

> 依据：产品定义 v1.1。目标：2026-09-01 上线。本文件面向 Claude Code，按此实现。
> 范围：web 全流程（The System 核心 + Room + Seat Watch + 计费桩）。Mac/iOS/邮件/Plus 深度功能不在本期。

## 0. 技术栈

- 前端：Next.js (App Router) + TypeScript + Tailwind；日历用自研 block 组件（不引 FullCalendar，需求太定制）
- 后端：Next.js API routes + 独立 worker 进程（node-cron）：SOC 轮询、计划重算、通知
- 数据库：Postgres（Supabase），启用 RLS；Supabase Auth 做邮箱 magic link
- LLM：服务端统一网关模块 `llm/gateway.ts`，engine tier 配置化（`TIER_PARSE`、`TIER_QUEST`、`TIER_MODERATE`），一律走不训练 API；所有调用写 usage_events
- 支付：Stripe Checkout（一次性 payment，非 subscription 模式）
- 部署：Vercel（web）+ Railway/Fly（worker）

## 1. 数据模型

约定：全表带 `school_id`（租户隔离）、`created_at/updated_at`。RLS：用户仅见本人行；Room 类表按 school_id + 成员关系。

```sql
-- 租户与身份
schools(id, name, edu_domains text[], campus_list jsonb, soc_adapter text)
users(id, school_id, email, display_name, major, grad_year, goal_archetype,
      sleep_start, sleep_end, timezone, level int default 1, xp bigint default 0,
      leaderboard_alias text, leaderboard_opt_in bool default true)
terms(id, school_id, code, starts_on, ends_on)   -- 'fall26'

-- 课程目录（SOC 适配器写入）
courses(id, school_id, term_id, code, title)
sections(id, course_id, index_no, campus, instructor, is_open bool, last_seen_open_at)
section_meetings(id, section_id, dow int, start_min int, end_min int, building, campus)

-- 用户输入三原语
user_sections(user_id, section_id, source, verified bool)             -- 固定重复块(课)
commitments(id, user_id, kind, title, freq_per_week, duration_min,
            intensity int, time_window jsonb, flexible bool)          -- 弹性目标/固定承诺
deadline_items(id, user_id, source, course_id, title, due_at,
               est_minutes, intensity int, status)                    -- ddl 源
imports(id, user_id, file_ref, detected_type, parse_json, confidence,
        status)                                                       -- 统一导入窗记录
canvas_links(user_id, token_enc, status, last_sync_at)

-- 计划与精力
plans(id, user_id, date, capacity_pct int, state, generated_at)
plan_blocks(id, plan_id, kind,               -- class|commute|task|commitment|buffer
            ref_table, ref_id, start_min, end_min, intensity int,
            reason_signal text, reason_effect text,
            status,                          -- planned|done|missed|shed|moved
            shed_reason text)
checkins(id, user_id, date, energy int, sleep_h numeric, mood int)    -- 一日一行
commute_matrix(school_id, campus_from, campus_to, minutes int)        -- 种子数据手工

-- Quest 系统
fact_entries(id, school_id, kind, title, body, source_url, valid_from, valid_to, reviewed bool)
quest_lines(id, user_id, type,               -- main|side|explore|social
            title, chapter jsonb, compiled_from jsonb, model_ver, status)
quests(id, quest_line_id, title, why text, fact_ref uuid[], window_start, window_end,
       est_minutes, xp int, status, completed_at)
xp_ledger(id, user_id, delta int, reason,    -- block_done|quest_done|event_checkin
          ref_id, ts)                        -- 结算唯一入口，防重入
levels(level int pk, xp_required bigint, perk_key text)
entitlements(user_id, feature_key, limit_val, source)                 -- plan|level_perk|promo
events(id, school_id, room_post_id, starts_at, venue, qr_secret, xp int)
event_checkins(user_id, event_id, ts)  -- unique(user_id,event_id)

-- Room
rooms(id, school_id, kind, name)             -- MVP: kind='school' 一个
room_posts(id, room_id, author_id, type,     -- recruit|event|party|buddy
           title, body, status,              -- pending|approved|rejected
           moderation jsonb,                 -- {model_verdict, confidence, rule_hits}
           reviewed_by, expires_at)
contact_handles(user_id, kind, value_enc)    -- wechat|qq|imessage|instagram|email
contact_requests(id, from_user, to_user, room_post_id, status,       -- pending|accepted|declined|revoked
                 decided_at)  -- unique(from_user,to_user)

-- Seat Watch 与商业化
seat_watches(id, user_id, section_id, status, created_at)
seat_events(id, section_id, kind,            -- opened|closed
            observed_at)                     -- 全局轮询器写入
subscriptions(id, user_id, plan,             -- seatwatch_unlimited|plus
              term_id, status, paid_at, amount_cents, stripe_ref)
usage_events(id, user_id, feature_key, engine_tier, tokens_in, tokens_out, cost_usd, ts)
quota_counters(user_id, feature_key, period, used int)

-- 埋点（另一条管道，不混业务表）
analytics_events(id, user_id, name, props jsonb, ts)
```

硬性约束：contact_handles.value_enc 与 canvas_links.token_enc 用 pgcrypto 应用层加密；任何日志/analytics_events.props 禁止出现课表明细、自报值、联系方式；删号 = 级联硬删 + Stripe ref 保留法务最小集。

## 2. 调度引擎（worker + 同步触发）

```
generate_day_plan(user, date):
  cap = capacity(user, date)                          # 见 §3
  blocks = []
  1 放硬块: user_sections 的 section_meetings → class block
  2 相邻硬块不同校区 → 插 commute block (commute_matrix + 10min 冗余)
  3 候选任务池: deadline_items(status=open) 展开为 task 候选
     priority = intensity * est_remaining / max(1, days_until_due)   # 压力分
  4 弹性承诺: commitments.flexible 按 freq_per_week 剩余次数生成候选
  5 填充: 候选按 priority 降序，塞入空档
     - 高强度任务优先放精力峰值段(默认 13:00–17:00，P1 由数据校准)
     - 日总负载 = Σ(duration*intensity) ≤ cap * DAY_BUDGET
     - 单任务 >90min 拆 pomodoro 块
  6 每块写 reason_signal/reason_effect（模板化字符串，非 LLM）
  7 diff 旧计划: 被移除块标 shed 不删行
replan 触发: checkin 提交 / deadline 新增 / block 标 missed / 手动拖动 → 只重算当日未来+后 6 天
```

## 3. 精力模块

```
capacity(user, date):
  base = clamp(sleep_hours(user) / 8, 0.6, 1.1)
  density = class_minutes(date) / 300        # 5h 课=满密度
  cap = base * (1 - 0.3*density)             # → 0~1.1
  checkin = 当日 energy(1-5)，无则 3
  cap *= [0.4, 0.7, 1.0, 1.1, 1.2][checkin-1]
保护模式: energy<=2 → shed 所有 priority 低于中位数的 task 块(status=shed,可撤销)，插 recovery 建议块
连续 3 天 energy<=2 → 本周 DAY_BUDGET *= 0.8，周复盘生成对应段落
```

## 4. Quest 编译器

- 触发：onboarding 完成 / 用户换 goal_archetype / 学期开始。结果缓存于 quest_lines.compiled_from
- Prompt 契约：输入 = {archetype, major, grad_year, 每周可投入 h, user_sections 摘要, 骨架 YAML, fact_entries(reviewed=true, school 匹配)}；输出 = 严格 JSON schema（quest_lines + quests[]，每个 quest 的 fact_ref 必填）
- 校验器（代码，非 LLM）：拒绝任何 fact_ref 为空或不存在的 quest；拒绝模型自产日期（quest 时间窗必须来自 fact 或相对学期锚点）；校验失败自动重试 1 次后降级为骨架默认线
- 派发（规则，零 LLM 成本）：每日晨间任务 = 各线最近未完成 quest；机会侦察 = events/room_posts 与 quest_line.type 匹配 + 用户当日有 ≥2h 空档 → 每日最多 1 条

## 5. SOC 轮询器（worker）

```
每 5 分钟: GET classes.rutgers.edu/soc/api/openSections.json?year&term&campus
  - User-Agent: "classmate-app/1.0 (contact@...)"
  - diff vs 上次快照(Redis/内存) → opened/closed 集合 → 写 seat_events
  - opened ∩ seat_watches(active) → 通知 fanout（email + web push）
  - 429/5xx → 指数退避，连续失败 30min 告警
课程目录: courses.json 每日 04:00 全量同步 courses/sections/section_meetings
```

## 6. Room 审核管道

```
POST /posts → status=pending → 队列 → moderation worker:
  prompt(TIER_MODERATE) = 贴文 + 版规 rubric → {type, verdict(pass/borderline/violate), confidence, rule_hits}
  pass & confidence>0.85 → approved（自动）
  violate & confidence>0.85 → rejected + 模板理由
  其余 → 人工队列（管理后台 /admin/moderation，Joe 账号 role=moderator）
后台动作: approve/reject/edit-type；全部写 moderation jsonb 审计
```

## 7. API 面（REST，全部 school_id 作用域）

```
Auth      POST /auth/magic-link（校验 edu_domains 白名单）
Import    POST /imports（multipart）→ GET /imports/:id（轮询解析态）→ POST /imports/:id/confirm
Canvas    POST /canvas/link  DELETE /canvas/link
Plan      GET /plan?date  POST /plan/blocks/:id/status  POST /plan/blocks（手动块）
          POST /plan/blocks/:id/move  POST /plan/replan
Checkin   POST /checkins  GET /checkins/today
Quests    GET /quest-lines  POST /quest-lines/recompile  POST /quests/:id/complete
XP        GET /me/xp  GET /leaderboard（Top N + 本人是否在榜，不返回名次外数据）
Rooms     GET /rooms/:id/posts  POST /rooms/:id/posts  POST /posts/:id/respond
Contacts  POST /contact-requests  POST /contact-requests/:id/accept|decline|revoke
          GET /me/contact-handles  PUT /me/contact-handles
Seat      GET /sections/search?q  POST /seat-watches  DELETE /seat-watches/:id
Billing   POST /billing/checkout(plan)  POST /webhooks/stripe
Events    POST /events/:id/checkin(qr_token)
Admin     GET/POST /admin/moderation/*  GET /admin/metrics
```

## 8. 系统人格文案引擎

- 实现：模板库 + 变量注入（MVP 不用 LLM 写日常消息，保证语气稳定成本为零）；Plus 的叙事版周复盘用 TIER_QUEST 生成
- 触发表：晨间简报(07:30 本地) / 空档开始(block 间隙>45min 且有候选任务) / 保护模式激活 / 断签次日 / 周日晚复盘
- 语气规范：冷静克制，说理由，不用感叹号，不用"加油"；禁止"你还有 N 项未完成"句式，使用"主线在等一步：X"
- 所有消息落 notifications 表 + web 端 inbox，email 仅晨间简报与 seat alert

## 9. 埋点（PostHog 自托管或 Supabase 表）

事件：`signup, import_started, import_confirmed, plan_issued, plan_viewed, checkin_submitted, block_completed, block_shed, quest_completed, event_checkin, room_post_created, contact_request_sent, contact_request_accepted, seat_alert_sent, paywall_viewed, purchase_completed`
北极星推导：DAU 领取率 = distinct(plan_viewed)/distinct(active users)；执行率 = block_completed/(planned-shed)。
红线：props 不含课表内容/自报值/联系方式，只含计数与布尔。

## 10. 验收标准（P0 全过才算 MVP 完成）

1. .edu 白名单注册→魔法链接登录，非白名单域名被拒
2. 上传 Rutgers 课表截图 → 解析 → 确认屏改错 → 日历出现课程块+自动通勤块，全程 <90s
3. Canvas token 粘贴 → 24h 内作业进 deadline_items 并出现在计划
4. 每日 checkin 一击提交；energy=1 触发保护模式且被砍块可撤销
5. 计划块拖动 → 联动重排 → 受影响块高亮
6. Onboarding 选 archetype → quest 线生成 → 每个 quest 的 why 可展开且 fact 来源可点
7. Room 发贴默认 pending，OpenClaw/moderation worker 判定路径三分支全通，人工队列可操作
8. 联系请求完整闭环：请求→接受→双方可见 handle→撤回后不可见
9. Seat Watch：免费用户第 3 门被 paywall 拦截；$4.99 Stripe 支付后解锁；开位通知 email 送达 <6min
10. 活动二维码打卡：重复扫码幂等，XP 只结算一次；周活动 XP 达 30% 上限后不再累计
11. 天道榜只显示 Top 10 与本人在榜状态，不泄露其他名次
12. 删号：登录态发起 → 主库用户数据即刻不可查 → contact/canvas 密文销毁
13. 全部 12 条埋点事件在测试环境可查询到

## 11. 八周里程碑

| 周 | 交付 |
|---|---|
| W1(7/7) | 库表+RLS+Auth+SOC 目录同步跑通 |
| W2 | 统一导入窗（课表截图→确认→块）+ commute matrix 种子 |
| W3 | 调度引擎+精力模块+Today 视图（含 reason 展开） |
| W4 | Checkin+保护模式+拖动重排+周视图 |
| W5 | Quest 编译器+fact 库工具+晨间简报+XP 结算 |
| W6 | Room+审核管道+联系交换+管理后台 |
| W7 | SOC 轮询器+Seat Watch+Stripe+活动打卡 |
| W8 | 天道榜+彩蛋 LV5/10+埋点全量+内测修复 buffer |

## 12. 本期明确不做

Mac/iOS、邮件接入、Plus 深度功能（10 月）、课程级 Room 分区、二手版面、k-匿名高级模糊化、分享卡图片生成服务（W8 后第一个增量）、多校适配（schema 已预留）。
