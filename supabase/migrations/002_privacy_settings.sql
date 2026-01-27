-- ============================================
-- ClassMate 隐私设置补充
-- ============================================

-- 1. 给 users 表添加隐私设置字段
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS share_contact BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS contact_visibility VARCHAR(20) DEFAULT 'room' 
  CHECK (contact_visibility IN ('room', 'public'));

-- share_contact: 是否允许他人看到微信/QQ（默认关闭）
-- contact_visibility: 可见范围
--   'room' = 仅同课群友可见（默认）
--   'public' = 公开可见（二期功能）

-- ============================================
-- 2. 创建辅助函数：检查两个用户是否是同课群友
-- ============================================
CREATE OR REPLACE FUNCTION public.are_roommates(viewer_id UUID, target_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  -- 检查是否有共同的 room
  RETURN EXISTS (
    SELECT 1 
    FROM public.room_members rm1
    JOIN public.room_members rm2 ON rm1.room_id = rm2.room_id
    WHERE rm1.user_id = viewer_id 
      AND rm2.user_id = target_id
      AND rm1.user_id != rm2.user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 3. 创建公开资料视图（展示他人信息时使用）
-- ============================================
CREATE OR REPLACE VIEW public.user_public_profiles AS
SELECT 
  u.id,
  u.nickname,
  u.avatar_url,
  u.school,
  u.share_contact,
  u.contact_visibility,
  -- 联系方式：只有当 share_contact=true 时才返回，否则返回 null
  CASE WHEN u.share_contact = true THEN u.wechat ELSE NULL END AS wechat,
  CASE WHEN u.share_contact = true THEN u.qq ELSE NULL END AS qq,
  u.created_at
FROM public.users u;

-- ============================================
-- 4. 创建函数：获取房间成员（带隐私过滤）
-- ============================================
CREATE OR REPLACE FUNCTION public.get_room_members_with_privacy(
  p_room_id UUID,
  p_viewer_id UUID
)
RETURNS TABLE (
  id UUID,
  nickname VARCHAR(50),
  avatar_url TEXT,
  school VARCHAR(100),
  wechat VARCHAR(50),
  qq VARCHAR(20),
  joined_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.id,
    u.nickname,
    u.avatar_url,
    u.school,
    -- 联系方式逻辑：
    -- 1. 如果是自己，显示自己的联系方式
    -- 2. 如果对方 share_contact=true 且 contact_visibility='room'，显示
    -- 3. 如果对方 share_contact=true 且 contact_visibility='public'，显示
    -- 4. 否则返回 null
    CASE 
      WHEN u.id = p_viewer_id THEN u.wechat
      WHEN u.share_contact = true AND u.contact_visibility IN ('room', 'public') THEN u.wechat
      ELSE NULL 
    END AS wechat,
    CASE 
      WHEN u.id = p_viewer_id THEN u.qq
      WHEN u.share_contact = true AND u.contact_visibility IN ('room', 'public') THEN u.qq
      ELSE NULL 
    END AS qq,
    rm.joined_at
  FROM public.room_members rm
  JOIN public.users u ON rm.user_id = u.id
  WHERE rm.room_id = p_room_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 5. 更新 member_count 触发器（如果还没创建）
-- ============================================
CREATE OR REPLACE FUNCTION public.handle_room_member_count()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE public.course_rooms
    SET member_count = member_count + 1
    WHERE id = NEW.room_id;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE public.course_rooms
    SET member_count = member_count - 1
    WHERE id = OLD.room_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_room_member_change ON public.room_members;
CREATE TRIGGER on_room_member_change
  AFTER INSERT OR DELETE ON public.room_members
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_room_member_count();

-- ============================================
-- 6. 给视图设置权限
-- ============================================
GRANT SELECT ON public.user_public_profiles TO authenticated;
GRANT SELECT ON public.user_public_profiles TO anon;
