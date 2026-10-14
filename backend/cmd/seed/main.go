// seed creates only synthetic development records in an explicitly named rewrite DB.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"courseforge/backend/internal/config"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if os.Getenv("CF_DEV_MODE") != "true" {
		return errors.New("seed requires CF_DEV_MODE=true")
	}
	c, err := config.FromEnv()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	p, err := store.Open(ctx, c.DatabaseURL, 2)
	if err != nil {
		return errors.New("cannot connect to development database")
	}
	defer p.Close()
	var db string
	if err = p.QueryRow(ctx, "SELECT current_database()").Scan(&db); err != nil {
		return err
	}
	if db != "courseforge_rewrite" {
		return errors.New("seed accepts only the courseforge_rewrite development database")
	}
	if err = store.Migrate(ctx, p); err != nil {
		return err
	}
	hash, err := identity.HashPassword("CourseForgeDemo2026!")
	if err != nil {
		return err
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, user := range []struct{ id, email, name, role string }{{"fixture_learner", "learner@example.test", "Demo learner", "student"}, {"fixture_admin", "admin@example.test", "Demo administrator", "admin"}, {"fixture_unverified", "unverified@example.test", "Pending learner", "student"}} {
		_, err = tx.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$2,$3,$4,$5,true)ON CONFLICT(id)DO NOTHING`, user.id, user.email, user.name, hash, user.role)
		if err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE users SET verified=false WHERE id='fixture_unverified'`); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO courses(id,title,description,published)VALUES('fixture-course','CourseForge demonstration','Synthetic lessons for isolated rewrite testing.',true)ON CONFLICT DO NOTHING`)
	if err != nil {
		return err
	}
	for i := 1; i <= 3; i++ {
		_, err = tx.Exec(ctx, `INSERT INTO lessons(id,course_id,title,sort_order,duration_seconds)VALUES($1,'fixture-course',$2,$3,30)ON CONFLICT DO NOTHING`, fmt.Sprintf("fixture-lesson-%d", i), fmt.Sprintf("Lesson %d — Playback and progress", i), i)
		if err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO courses(id,title,published)VALUES('fixture-other','Other published course',true),('fixture-unpublished','Unpublished course',false)ON CONFLICT DO NOTHING;INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('fixture-other-lesson','fixture-other','Other lesson',30),('fixture-unpublished-lesson','fixture-unpublished','Unpublished lesson',30)ON CONFLICT DO NOTHING`)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO enrollments(user_id,course_id)VALUES('fixture_learner','fixture-course')ON CONFLICT DO NOTHING`)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Println("Synthetic rewrite fixtures ready. Local demo accounts: learner@example.test and admin@example.test; password CourseForgeDemo2026!")
	return nil
}
