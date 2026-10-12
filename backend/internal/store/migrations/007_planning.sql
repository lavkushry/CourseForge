CREATE TABLE planner_preferences (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 daily_minutes integer NOT NULL DEFAULT 45 CHECK(daily_minutes BETWEEN 15 AND 180),
 path_id text, path_course_id text REFERENCES courses(id) ON DELETE SET NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE week_preferences (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 weekday_minutes integer[] NOT NULL CHECK(array_length(weekday_minutes,1)=7),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE daily_plans (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_date date NOT NULL, path_id text, path_course_id text REFERENCES courses(id) ON DELETE SET NULL,
 budget_minutes integer NOT NULL CHECK(budget_minutes BETWEEN 15 AND 180),
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100), legacy_tz_offset_minutes integer CHECK(legacy_tz_offset_minutes BETWEEN -840 AND 840),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,study_date),UNIQUE(id,user_id)
);
CREATE TABLE daily_plan_items (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plan_id text NOT NULL, item_key text NOT NULL CHECK(length(item_key) BETWEEN 1 AND 500),
 kind text NOT NULL CHECK(kind IN('lesson','review','assessment','lab')),
 course_id text REFERENCES courses(id) ON DELETE SET NULL, lesson_id text,
 path_id text,step_id text,lab_slug text,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 180),description text NOT NULL CHECK(length(description)<=350),
 minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 180), sort_order integer NOT NULL CHECK(sort_order>=0),
 action jsonb NOT NULL CHECK(jsonb_typeof(action)='object' AND octet_length(action::text)<=16384),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','done','skipped')),
 actual_minutes integer NOT NULL DEFAULT 0 CHECK(actual_minutes BETWEEN 0 AND 600),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_id,item_key),UNIQUE(id,user_id),
 FOREIGN KEY(plan_id,user_id) REFERENCES daily_plans(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(lesson_id,course_id) REFERENCES lessons(id,course_id) ON DELETE SET NULL,
 CHECK(lesson_id IS NULL OR course_id IS NOT NULL),
 CHECK(step_id IS NULL OR path_id IS NOT NULL),
 CHECK(lab_slug IS NULL OR(path_id IS NOT NULL AND step_id IS NOT NULL))
);
CREATE INDEX daily_plan_items_owner ON daily_plan_items(user_id,plan_id,sort_order,id);
CREATE TABLE weekly_plans (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 week_start date NOT NULL CHECK(extract(isodow FROM week_start)=1),
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100), legacy_tz_offset_minutes integer CHECK(legacy_tz_offset_minutes BETWEEN -840 AND 840),
 weekday_minutes integer[] NOT NULL CHECK(array_length(weekday_minutes,1)=7),
 forecast jsonb NOT NULL CHECK(jsonb_typeof(forecast)='array' AND jsonb_array_length(forecast)=7),
 unscheduled_reviews bigint NOT NULL DEFAULT 0 CHECK(unscheduled_reviews>=0),
 path_id text,path_course_id text REFERENCES courses(id) ON DELETE SET NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,week_start)
);
CREATE TABLE focus_sessions (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN('focus','break')),
 status text NOT NULL CHECK(status IN('running','paused','finished','cancelled')),
 duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 60 AND 7200),
 elapsed_seconds double precision NOT NULL DEFAULT 0 CHECK(elapsed_seconds>=0 AND elapsed_seconds<=duration_seconds),
 run_started_at timestamptz, planner_item_id text,
 lesson_id text,course_id text REFERENCES courses(id) ON DELETE SET NULL,lab_session_id text,source_required boolean NOT NULL DEFAULT false,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),interval_count integer NOT NULL DEFAULT 1 CHECK(interval_count BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id),
 FOREIGN KEY(planner_item_id,user_id) REFERENCES daily_plan_items(id,user_id) ON DELETE SET NULL (planner_item_id),
 FOREIGN KEY(lesson_id,course_id) REFERENCES lessons(id,course_id) ON DELETE SET NULL,
 CHECK(lesson_id IS NULL OR course_id IS NOT NULL),
 CHECK((status='running')=(run_started_at IS NOT NULL)),CHECK(updated_at>=created_at)
);
CREATE UNIQUE INDEX focus_one_running ON focus_sessions(user_id) WHERE status='running';
CREATE INDEX focus_owner_history ON focus_sessions(user_id,created_at DESC,id DESC);
CREATE TABLE focus_intervals (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,session_id text NOT NULL,
 began_at timestamptz NOT NULL,ended_at timestamptz CHECK(ended_at>=began_at),
 FOREIGN KEY(session_id,user_id) REFERENCES focus_sessions(id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX focus_one_interval ON focus_intervals(session_id) WHERE ended_at IS NULL;
CREATE INDEX focus_interval_analytics ON focus_intervals(user_id,began_at,session_id);
CREATE TABLE planning_commands (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 kind text NOT NULL,request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=1048576),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,idempotency_key)
);
CREATE TABLE habit_preferences (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 goal text NOT NULL DEFAULT 'minutes' CHECK(goal IN('minutes','lesson')),
 reminder_email boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE habit_actions (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('lesson','quiz','review')),resource text NOT NULL,
 day date NOT NULL,credited_at timestamptz NOT NULL,PRIMARY KEY(user_id,kind,resource,day)
);
CREATE TABLE habit_days (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,day date NOT NULL,
 watched_seconds double precision NOT NULL DEFAULT 0 CHECK(watched_seconds>=0 AND watched_seconds<1e12),
 lessons bigint NOT NULL DEFAULT 0 CHECK(lessons>=0),quizzes bigint NOT NULL DEFAULT 0 CHECK(quizzes>=0),reviews bigint NOT NULL DEFAULT 0 CHECK(reviews>=0),
 goal_met boolean NOT NULL DEFAULT false,PRIMARY KEY(user_id,day)
);
CREATE INDEX habit_achievements ON habit_days(user_id,day DESC) WHERE goal_met;
CREATE FUNCTION planning_valid_budgets(v integer[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT array_ndims(v)=1 AND cardinality(v)=7
 AND EXISTS(SELECT 1 FROM unnest(v)n WHERE n>0)
 AND NOT EXISTS(SELECT 1 FROM unnest(v)n WHERE n IS NULL OR(n<>0 AND(n<15 OR n>180)));
$$;
ALTER TABLE week_preferences ADD CONSTRAINT week_preferences_valid_budgets CHECK(planning_valid_budgets(weekday_minutes));
ALTER TABLE weekly_plans ADD CONSTRAINT weekly_plans_valid_budgets CHECK(planning_valid_budgets(weekday_minutes));

CREATE FUNCTION planning_habit_zone(uid text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE zone text;
BEGIN
 INSERT INTO learning_preferences(user_id,timezone)VALUES(uid,'UTC')ON CONFLICT DO NOTHING;
 INSERT INTO habit_preferences(user_id)VALUES(uid)ON CONFLICT DO NOTHING;
 SELECT timezone INTO zone FROM learning_preferences WHERE user_id=uid;
 RETURN zone;
END;
$$;
CREATE FUNCTION planning_habit_check(uid text,d date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE habit_days SET goal_met=true WHERE user_id=uid AND day=d AND NOT goal_met AND
 (CASE (SELECT goal FROM habit_preferences WHERE user_id=uid)
  WHEN 'minutes' THEN watched_seconds>=900 ELSE lessons+quizzes+reviews>=1 END);
END;
$$;
CREATE FUNCTION planning_habit_action(uid text,k text,r text,at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE zone text;d date;inserted integer;
BEGIN
 zone:=planning_habit_zone(uid);d:=(at AT TIME ZONE zone)::date;
 INSERT INTO habit_actions(user_id,kind,resource,day,credited_at)VALUES(uid,k,r,d,at)ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted=0 THEN RETURN;END IF;
 INSERT INTO habit_days(user_id,day,lessons,quizzes,reviews)VALUES(uid,d,(k='lesson')::integer,(k='quiz')::integer,(k='review')::integer)
 ON CONFLICT(user_id,day)DO UPDATE SET lessons=habit_days.lessons+excluded.lessons,quizzes=habit_days.quizzes+excluded.quizzes,reviews=habit_days.reviews+excluded.reviews;
 PERFORM planning_habit_check(uid,d);
END;
$$;
CREATE FUNCTION planning_learning_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM planning_habit_action(NEW.user_id,NEW.kind,NEW.resource,NEW.credited_at);RETURN NEW;
END;
$$;
CREATE TRIGGER learning_habit_projection AFTER INSERT ON learning_credits FOR EACH ROW EXECUTE FUNCTION planning_learning_credit();
CREATE FUNCTION planning_completion_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.completed AND (TG_OP='INSERT' OR NOT OLD.completed) THEN
  PERFORM planning_habit_action(NEW.user_id,'lesson',NEW.lesson_id,NEW.updated_at);
 END IF;RETURN NEW;
END;
$$;
CREATE TRIGGER progress_habit_projection AFTER INSERT OR UPDATE OF completed ON progress FOR EACH ROW EXECUTE FUNCTION planning_completion_credit();
CREATE FUNCTION planning_watch_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seconds double precision;zone text;cursor_at timestamptz;stop_at timestamptz;left_at timestamptz;right_at timestamptz;mid_at timestamptz;d date;
BEGIN
 seconds:=NEW.watched_seconds-OLD.watched_seconds;
 IF seconds<=0 THEN RETURN NEW;END IF;
 IF seconds>20.000001 OR seconds='Infinity'::float8 OR seconds='NaN'::float8 THEN RAISE EXCEPTION 'invalid accepted watch delta' USING ERRCODE='23514';END IF;
 seconds:=least(seconds,20);
 zone:=planning_habit_zone(NEW.user_id);cursor_at:=NEW.baseline_at-seconds*interval '1 second';
 WHILE cursor_at<NEW.baseline_at LOOP
  d:=(cursor_at AT TIME ZONE zone)::date;stop_at:=NEW.baseline_at;
  -- Find the actual boundary only when this <=20s delta crosses local days.
  -- Binary search avoids choosing the second occurrence of an ambiguous
  -- midnight, and handles skipped local dates without minute-by-minute scans.
  IF (NEW.baseline_at AT TIME ZONE zone)::date<>d THEN
   left_at:=cursor_at;right_at:=NEW.baseline_at;
   WHILE right_at-left_at>interval '1 microsecond' LOOP
    mid_at:=left_at+(right_at-left_at)/2;
    IF (mid_at AT TIME ZONE zone)::date=d THEN left_at:=mid_at;ELSE right_at:=mid_at;END IF;
   END LOOP;
   stop_at:=right_at;
  END IF;
  INSERT INTO habit_days(user_id,day,watched_seconds)VALUES(NEW.user_id,d,extract(epoch FROM stop_at-cursor_at))
  ON CONFLICT(user_id,day)DO UPDATE SET watched_seconds=habit_days.watched_seconds+excluded.watched_seconds;
  PERFORM planning_habit_check(NEW.user_id,d);cursor_at:=stop_at;
 END LOOP;RETURN NEW;
END;
$$;
CREATE TRIGGER playback_habit_projection AFTER UPDATE OF watched_seconds ON playback_sessions FOR EACH ROW EXECUTE FUNCTION planning_watch_credit();
-- Existing accepted action timestamps are available. Historical watch-day totals
-- require the legacy habit snapshot; lifetime playback totals cannot recreate it.
SELECT planning_habit_action(user_id,kind,resource,credited_at) FROM learning_credits;
SELECT planning_habit_action(user_id,'lesson',lesson_id,updated_at) FROM progress WHERE completed;
