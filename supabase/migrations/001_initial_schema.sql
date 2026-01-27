-- ClassMate Database Schema
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Users Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) UNIQUE NOT NULL,
  email_verified BOOLEAN DEFAULT false,
  is_edu_email BOOLEAN DEFAULT false,
  nickname VARCHAR(50) NOT NULL,
  avatar_url TEXT,
  wechat VARCHAR(50),
  qq VARCHAR(20),
  school VARCHAR(100),
  match_quota_remaining INT DEFAULT 10,
  match_quota_reset_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- Semesters Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.semesters (
  id VARCHAR(20) PRIMARY KEY, -- e.g., "2025-spring", "2025-fall"
  name VARCHAR(50) NOT NULL,
  start_date DATE,
  end_date DATE,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default semesters
INSERT INTO public.semesters (id, name, start_date, end_date, is_active) VALUES
  ('2024-fall', '2024 Fall', '2024-09-01', '2024-12-31', false),
  ('2025-spring', '2025 Spring', '2025-01-15', '2025-05-31', true),
  ('2025-fall', '2025 Fall', '2025-09-01', '2025-12-31', false),
  ('2026-spring', '2026 Spring', '2026-01-15', '2026-05-31', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- Courses Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(200) NOT NULL,
  code VARCHAR(50),
  school VARCHAR(100) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(name, school)
);

-- ============================================
-- Course Rooms Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.course_rooms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  semester_id VARCHAR(20) NOT NULL REFERENCES public.semesters(id),
  
  day_of_week INT NOT NULL CHECK (day_of_week >= 1 AND day_of_week <= 7),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  professor VARCHAR(100) DEFAULT '',
  classroom VARCHAR(100) DEFAULT '',
  weeks VARCHAR(50) DEFAULT '',
  
  member_count INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique constraint for room identification
  UNIQUE(course_id, semester_id, day_of_week, start_time, professor, classroom)
);

-- ============================================
-- Room Members Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.room_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID NOT NULL REFERENCES public.course_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(room_id, user_id)
);

-- ============================================
-- Schedule Imports Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.schedule_imports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  semester_id VARCHAR(20) REFERENCES public.semesters(id),
  image_url TEXT,
  raw_result JSONB,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- Notifications Table
-- ============================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200),
  content TEXT,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- Indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_room_members_room ON public.room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON public.room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_course_rooms_course ON public.course_rooms(course_id);
CREATE INDEX IF NOT EXISTS idx_course_rooms_semester ON public.course_rooms(semester_id);
CREATE INDEX IF NOT EXISTS idx_courses_school ON public.courses(school);

-- ============================================
-- Row Level Security (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users: Users can read all profiles, update only their own
CREATE POLICY "Users can view all profiles" ON public.users
  FOR SELECT USING (true);

CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Courses: Anyone can read, only authenticated can insert
CREATE POLICY "Anyone can view courses" ON public.courses
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can create courses" ON public.courses
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Course Rooms: Anyone can read, only authenticated can insert
CREATE POLICY "Anyone can view rooms" ON public.course_rooms
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can create rooms" ON public.course_rooms
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update rooms" ON public.course_rooms
  FOR UPDATE USING (auth.role() = 'authenticated');

-- Room Members: Anyone can read, users manage their own membership
CREATE POLICY "Anyone can view room members" ON public.room_members
  FOR SELECT USING (true);

CREATE POLICY "Users can join rooms" ON public.room_members
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can leave rooms" ON public.room_members
  FOR DELETE USING (auth.uid() = user_id);

-- Schedule Imports: Users can manage their own imports
CREATE POLICY "Users can view own imports" ON public.schedule_imports
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create imports" ON public.schedule_imports
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own imports" ON public.schedule_imports
  FOR UPDATE USING (auth.uid() = user_id);

-- Notifications: Users can only see their own
CREATE POLICY "Users can view own notifications" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications" ON public.notifications
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role can do anything (for API)
CREATE POLICY "Service role full access users" ON public.users
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access courses" ON public.courses
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access rooms" ON public.course_rooms
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access members" ON public.room_members
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access imports" ON public.schedule_imports
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access notifications" ON public.notifications
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- Functions
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for users table
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Function to check if email is edu email
CREATE OR REPLACE FUNCTION public.is_edu_email(email TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN email ~* '\.(edu|edu\.[a-z]{2}|ac\.[a-z]{2})$';
END;
$$ LANGUAGE plpgsql;
