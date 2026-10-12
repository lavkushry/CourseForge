package identity

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// Mailer receives links only after token persistence. Implementations must not
// log links or credentials. Tests inject a recorder without contacting SMTP.
type Mailer interface {
	Send(ctx context.Context, email, kind, accountURL string) error
}
type SMTPMailer struct {
	Host                 string
	Port                 int
	From, User, Password string
}

func NewSMTPFromEnv() (Mailer, error) {
	host := os.Getenv("SMTP_HOST")
	from := os.Getenv("SMTP_FROM")
	if host == "" && from == "" {
		return nil, nil
	}
	if host == "" || from == "" {
		return nil, errors.New("SMTP_HOST and SMTP_FROM must both be configured")
	}
	address, err := mail.ParseAddress(from)
	if err != nil || strings.ContainsAny(from, "\r\n") {
		return nil, errors.New("invalid SMTP_FROM")
	}
	port := 587
	if raw := os.Getenv("SMTP_PORT"); raw != "" {
		port, err = strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid SMTP_PORT")
		}
	}
	return &SMTPMailer{Host: host, Port: port, From: address.Address, User: os.Getenv("SMTP_USER"), Password: os.Getenv("SMTP_PASSWORD")}, nil
}
func (m *SMTPMailer) Send(ctx context.Context, email, kind, accountURL string) error {
	if _, err := mail.ParseAddress(email); err != nil || strings.ContainsAny(email, "\r\n") {
		return errors.New("invalid recipient")
	}
	conn, err := (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(m.Host, strconv.Itoa(m.Port)))
	if err != nil {
		return errors.New("account mail unavailable")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	client, err := smtp.NewClient(conn, m.Host)
	if err != nil {
		return errors.New("account mail unavailable")
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); !ok {
		return errors.New("account mail requires TLS")
	}
	if err = client.StartTLS(&tls.Config{ServerName: m.Host, MinVersion: tls.VersionTLS12}); err != nil {
		return errors.New("account mail unavailable")
	}
	if m.User != "" {
		if err = client.Auth(smtp.PlainAuth("", m.User, m.Password, m.Host)); err != nil {
			return errors.New("account mail unavailable")
		}
	}
	if err = client.Mail(m.From); err != nil {
		return errors.New("account mail unavailable")
	}
	if err = client.Rcpt(email); err != nil {
		return errors.New("account mail unavailable")
	}
	writer, err := client.Data()
	if err != nil {
		return errors.New("account mail unavailable")
	}
	subject := "Verify your CourseForge account"
	if kind == "reset" {
		subject = "Reset your CourseForge password"
	}
	if _, err = fmt.Fprintf(writer, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOpen this link to continue:\r\n%s\r\n\r\nIf you did not request this, ignore this email.\r\n", m.From, email, subject, accountURL); err != nil {
		return errors.New("account mail unavailable")
	}
	if err = writer.Close(); err != nil {
		return errors.New("account mail unavailable")
	}
	if err = client.Quit(); err != nil {
		return errors.New("account mail unavailable")
	}
	return nil
}
