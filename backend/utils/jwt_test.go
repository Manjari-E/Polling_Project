package utils

import (
	"os"
	"testing"
)

func TestGenerateToken(t *testing.T) {
	os.Setenv("JWT_SECRET", "test-secret-key")

	token, err := GenerateToken("user-123", "test@example.com")
	if err != nil {
		t.Fatalf("Expected token generation to succeed, got error: %v", err)
	}

	if token == "" {
		t.Fatal("Expected non-empty token string")
	}
}

func TestGenerateTokenMissingSecret(t *testing.T) {
	os.Unsetenv("JWT_SECRET")

	_, err := GenerateToken("user-123", "test@example.com")
	if err == nil {
		t.Fatal("Expected error when JWT_SECRET is not configured, got nil")
	}
}
