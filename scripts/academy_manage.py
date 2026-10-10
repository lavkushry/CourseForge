#!/usr/bin/env python3
"""Local administrator setup, recovery and consistent SQLite backups."""
import argparse
import getpass
import os
from pathlib import Path
import secrets
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings
from app.db import connect, init_db
from app import auth


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    backup = commands.add_parser('backup')
    backup.add_argument('--output', type=Path, required=True)
    commands.add_parser('migrate')
    for name in ('bootstrap-admin', 'set-password'):
        command = commands.add_parser(name)
        command.add_argument('--email', required=True)
        if name == 'bootstrap-admin':
            command.add_argument('--name', default='Administrator')
        command.add_argument('--generate', action='store_true', help='Save a generated password to a private file instead of prompting')
        command.add_argument('--password-file', type=Path, default=settings.data_dir/'initial-admin-password.txt')
    args = parser.parse_args()
    if args.command == 'backup':
        args.output.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        try:
            with sqlite3.connect(f'file:{settings.db_path}?mode=ro', uri=True) as source, sqlite3.connect(args.output) as target:
                source.backup(target)
        except BaseException:
            args.output.unlink(missing_ok=True)
            raise
        print(f'Database backup saved to {args.output}')
        return
    init_db()
    if args.command == 'migrate':
        print('Database migration complete')
        return
    email = auth.normalize_email(args.email)
    if args.generate:
        password = secrets.token_urlsafe(24)
        args.password_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.password_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(password + '\n')
    else:
        password = getpass.getpass('New password (12–128 characters): ')
        if password != getpass.getpass('Confirm password: '):
            raise SystemExit('Passwords do not match')
    try:
        auth.validate_password(password)
        if args.command == 'bootstrap-admin':
            auth.bootstrap_admin(email, args.name.strip() or 'Administrator', password)
        else:
            encoded = auth.hasher.hash(password)
            with connect() as db:
                row = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
                if not row:
                    raise ValueError('Account not found')
                db.execute('UPDATE users SET password_hash=? WHERE id=?', (encoded, row['id']))
                db.execute('DELETE FROM auth_sessions WHERE user_id=?', (row['id'],))
                db.execute('DELETE FROM account_tokens WHERE user_id=?', (row['id'],))
    except BaseException:
        if args.generate:
            args.password_file.unlink(missing_ok=True)
        raise
    print(f'{args.command} complete for {email}')
    if args.generate:
        print(f'Password saved privately to {args.password_file}; change it in Account and remove this file afterwards.')


if __name__ == '__main__':
    main()
