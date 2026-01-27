-- Update course_rooms uniqueness to include end_time and weeks

ALTER TABLE public.course_rooms
  DROP CONSTRAINT IF EXISTS course_rooms_course_id_semester_id_day_of_week_start_time_professor_classroom_key;

ALTER TABLE public.course_rooms
  ADD CONSTRAINT course_rooms_unique_section
  UNIQUE (course_id, semester_id, day_of_week, start_time, end_time, professor, classroom, weeks);
