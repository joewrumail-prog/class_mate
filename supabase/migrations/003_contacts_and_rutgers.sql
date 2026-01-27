-- ============================================
-- ClassMate 联系方式请求与 Rutgers 课程缓存
-- ============================================

-- 1. 给 users 表添加一键公开字段
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS auto_share_contact BOOLEAN DEFAULT false;

-- auto_share_contact = true 时，进入任何房间自动公开联系方式，不再弹窗询问

-- ============================================
-- 2. 好友关系表（双方同意后永久互相可见联系方式）
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id_1 UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_id_2 UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  room_id UUID REFERENCES public.course_rooms(id) ON DELETE SET NULL,  -- 在哪个房间建立的联系
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- 确保每对用户只有一条记录（无论顺序）
  CONSTRAINT unique_connection CHECK (user_id_1 < user_id_2),
  UNIQUE(user_id_1, user_id_2)
);

-- ============================================
-- 3. 联系方式请求表
-- ============================================
-- contact_requests: 调整列名以匹配 API
CREATE TABLE IF NOT EXISTS public.contact_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  room_id UUID REFERENCES public.course_rooms(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  message TEXT,  -- 可选的请求留言
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  responded_at TIMESTAMP WITH TIME ZONE,
  
  -- 每对用户只能有一个活跃的请求
  UNIQUE(requester_id, target_user_id)
);

-- ============================================
-- 4. Rutgers 课程缓存表
-- ============================================
CREATE TABLE IF NOT EXISTS public.rutgers_courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  index VARCHAR(10) NOT NULL,  -- Rutgers section index (e.g., "10364")
  year INT NOT NULL,
  term INT NOT NULL,  -- 1=Spring, 7=Fall, 0=Winter, 9=Summer
  campus VARCHAR(10) NOT NULL DEFAULT 'NB',  -- NB, NK, CM
  subject VARCHAR(10),  -- e.g., "198" for CS
  course_number VARCHAR(10),  -- e.g., "111"
  course_string VARCHAR(50),  -- e.g., "01:198:111"
  title VARCHAR(200),
  instructor TEXT,
  meeting_day VARCHAR(20),  -- M, T, W, H, F or combinations
  start_time VARCHAR(10),  -- e.g., "0200" (military time)
  end_time VARCHAR(10),
  building VARCHAR(50),
  room_number VARCHAR(50),
  campus_name VARCHAR(100),  -- e.g., "BUSCH"
  open_status BOOLEAN DEFAULT true,
  credits VARCHAR(10),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(index, year, term)
);

-- ============================================
-- 5. 房间隐私设置表（记录用户在哪些房间公开了联系方式）
-- ============================================
-- room_privacy_settings: 调整列名以匹配 API
CREATE TABLE IF NOT EXISTS public.room_privacy_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES public.course_rooms(id) ON DELETE CASCADE,
  is_public BOOLEAN DEFAULT false,  -- 是否在此房间公开联系方式
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id, room_id)
);

-- ============================================
-- 6. 索引
-- ============================================
CREATE INDEX IF NOT EXISTS idx_user_connections_user_1 ON public.user_connections(user_id_1);
CREATE INDEX IF NOT EXISTS idx_user_connections_user_2 ON public.user_connections(user_id_2);
CREATE INDEX IF NOT EXISTS idx_contact_requests_requester ON public.contact_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_contact_requests_target ON public.contact_requests(target_user_id);
CREATE INDEX IF NOT EXISTS idx_contact_requests_status ON public.contact_requests(status);
CREATE INDEX IF NOT EXISTS idx_rutgers_courses_index ON public.rutgers_courses(index);
CREATE INDEX IF NOT EXISTS idx_rutgers_courses_search ON public.rutgers_courses(year, term, campus);
CREATE INDEX IF NOT EXISTS idx_rutgers_courses_title ON public.rutgers_courses USING gin(to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_room_privacy_user ON public.room_privacy_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_room_privacy_room ON public.room_privacy_settings(room_id);

-- ============================================
-- 7. Row Level Security (RLS)
-- ============================================
ALTER TABLE public.user_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rutgers_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_privacy_settings ENABLE ROW LEVEL SECURITY;

-- user_connections: 用户只能看到自己的连接
CREATE POLICY "Users can view own connections" ON public.user_connections
  FOR SELECT USING (auth.uid() = user_id_1 OR auth.uid() = user_id_2);

CREATE POLICY "Users can create connections" ON public.user_connections
  FOR INSERT WITH CHECK (auth.uid() = user_id_1 OR auth.uid() = user_id_2);

-- contact_requests: 用户可以看到自己发送或收到的请求
CREATE POLICY "Users can view own requests" ON public.contact_requests
  FOR SELECT USING (auth.uid() = requester_id OR auth.uid() = target_user_id);

CREATE POLICY "Users can create requests" ON public.contact_requests
  FOR INSERT WITH CHECK (auth.uid() = requester_id);

CREATE POLICY "Users can update requests they received" ON public.contact_requests
  FOR UPDATE USING (auth.uid() = target_user_id);

-- rutgers_courses: 所有人可读
CREATE POLICY "Anyone can view rutgers courses" ON public.rutgers_courses
  FOR SELECT USING (true);

-- room_privacy_settings: 用户只能管理自己的设置
CREATE POLICY "Users can view own privacy settings" ON public.room_privacy_settings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage own privacy settings" ON public.room_privacy_settings
  FOR ALL USING (auth.uid() = user_id);

-- Service role full access
CREATE POLICY "Service role full access connections" ON public.user_connections
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access requests" ON public.contact_requests
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access rutgers" ON public.rutgers_courses
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access privacy" ON public.room_privacy_settings
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- 8. 辅助函数：检查两个用户是否已建立连接
-- ============================================
CREATE OR REPLACE FUNCTION public.are_connected(p_user_id_1 UUID, p_user_id_2 UUID)
RETURNS BOOLEAN AS $$
DECLARE
  a_id UUID;
  b_id UUID;
BEGIN
  -- 确保 a_id < b_id 以匹配约束
  IF p_user_id_1 < p_user_id_2 THEN
    a_id := p_user_id_1;
    b_id := p_user_id_2;
  ELSE
    a_id := p_user_id_2;
    b_id := p_user_id_1;
  END IF;
  
  RETURN EXISTS (
    SELECT 1 FROM public.user_connections
    WHERE user_id_1 = a_id AND user_id_2 = b_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 9. 辅助函数：检查是否可以重新发送请求（1小时后）
-- ============================================
CREATE OR REPLACE FUNCTION public.can_request_contact(p_requester_id UUID, p_target_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  last_request RECORD;
BEGIN
  -- 检查是否已经是好友
  IF public.are_connected(p_requester_id, p_target_id) THEN
    RETURN false;
  END IF;
  
  -- 查找最近的请求
  SELECT * INTO last_request
  FROM public.contact_requests
  WHERE requester_id = p_requester_id AND target_user_id = p_target_id
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- 如果没有请求记录，可以发送
  IF NOT FOUND THEN
    RETURN true;
  END IF;
  
  -- 如果请求还在 pending 状态，不能重复发送
  IF last_request.status = 'pending' THEN
    RETURN false;
  END IF;
  
  -- 如果被拒绝，检查是否已过 1 小时
  IF last_request.status = 'rejected' THEN
    RETURN last_request.responded_at < NOW() - INTERVAL '1 hour';
  END IF;
  
  -- 已批准的不需要再请求
  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 10. 触发器：更新 room_privacy_settings 的 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION public.update_room_privacy_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_room_privacy_updated_at ON public.room_privacy_settings;
CREATE TRIGGER update_room_privacy_updated_at
  BEFORE UPDATE ON public.room_privacy_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_room_privacy_updated_at();
