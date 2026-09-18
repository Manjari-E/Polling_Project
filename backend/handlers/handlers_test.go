package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"pulsepoll/backend/handlers"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestSignupValidation(t *testing.T) {
	router := gin.New()
	router.POST("/api/auth/signup", handlers.Signup)

	tests := []struct {
		name         string
		payload      map[string]interface{}
		expectedCode int
	}{
		{
			name: "empty body",
			payload: map[string]interface{}{},
			expectedCode: http.StatusBadRequest,
		},
		{
			name: "invalid email format",
			payload: map[string]interface{}{
				"name":     "Alice",
				"email":    "not-an-email",
				"password": "password123",
			},
			expectedCode: http.StatusBadRequest,
		},
		{
			name: "short password",
			payload: map[string]interface{}{
				"name":     "Alice",
				"email":    "alice@example.com",
				"password": "123",
			},
			expectedCode: http.StatusBadRequest,
		},
		{
			name: "short name",
			payload: map[string]interface{}{
				"name":     "A",
				"email":    "alice@example.com",
				"password": "password123",
			},
			expectedCode: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.payload)
			req, _ := http.NewRequest(http.MethodPost, "/api/auth/signup", bytes.NewBuffer(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			if w.Code != tc.expectedCode {
				t.Errorf("expected status %d, got %d, body: %s", tc.expectedCode, w.Code, w.Body.String())
			}
		})
	}
}

func TestCreatePollValidation(t *testing.T) {
	router := gin.New()
	// Middleware setting user_id
	router.POST("/api/polls", func(c *gin.Context) {
		c.Set("user_id", "660000000000000000000001")
		c.Next()
	}, handlers.CreatePoll)

	tests := []struct {
		name         string
		payload      map[string]interface{}
		expectedCode int
	}{
		{
			name: "empty question",
			payload: map[string]interface{}{
				"question": "",
				"options":  []string{"Option 1", "Option 2"},
			},
			expectedCode: http.StatusBadRequest,
		},
		{
			name: "too few options",
			payload: map[string]interface{}{
				"question": "What is your favorite color?",
				"options":  []string{"Option 1"},
			},
			expectedCode: http.StatusBadRequest,
		},
		{
			name: "duplicate options",
			payload: map[string]interface{}{
				"question": "What is your favorite color?",
				"options":  []string{"Blue", "blue"},
			},
			expectedCode: http.StatusBadRequest,
		},
		{
			name: "empty option string",
			payload: map[string]interface{}{
				"question": "What is your favorite color?",
				"options":  []string{"Blue", "  "},
			},
			expectedCode: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.payload)
			req, _ := http.NewRequest(http.MethodPost, "/api/polls", bytes.NewBuffer(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			if w.Code != tc.expectedCode {
				t.Errorf("expected status %d, got %d, body: %s", tc.expectedCode, w.Code, w.Body.String())
			}
		})
	}
}
