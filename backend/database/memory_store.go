package database

import (
	"errors"
	"strings"
	"sync"

	"pulsepoll/backend/models"
)

type memoryStore struct {
	mu    sync.RWMutex
	users map[string]models.User   // email -> user
	polls map[string]models.Poll   // id hex -> poll
}

var MemStore = &memoryStore{
	users: make(map[string]models.User),
	polls: make(map[string]models.Poll),
}

func (m *memoryStore) SaveUser(user models.User) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	emailKey := strings.ToLower(user.Email)
	if _, exists := m.users[emailKey]; exists {
		return errors.New("duplicate key: email is already registered")
	}

	m.users[emailKey] = user
	return nil
}

func (m *memoryStore) FindUserByEmail(email string) (*models.User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	user, exists := m.users[strings.ToLower(email)]
	if !exists {
		return nil, errors.New("user not found")
	}
	return &user, nil
}

func (m *memoryStore) SavePoll(poll models.Poll) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.polls[poll.ID.Hex()] = poll
	return nil
}

func (m *memoryStore) GetAllPolls() []models.Poll {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]models.Poll, 0, len(m.polls))
	for _, p := range m.polls {
		result = append(result, p)
	}
	return result
}

func (m *memoryStore) GetPollByID(id string) (*models.Poll, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	poll, exists := m.polls[id]
	if !exists {
		return nil, errors.New("poll not found")
	}
	return &poll, nil
}

func (m *memoryStore) RecordVote(pollID string, optionIndex int, voterKey string) (*models.Poll, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	poll, exists := m.polls[pollID]
	if !exists {
		return nil, errors.New("poll not found")
	}

	if poll.Status != "active" {
		return nil, errors.New("poll is not active")
	}

	if optionIndex < 0 || optionIndex >= len(poll.Options) {
		return nil, errors.New("invalid option index")
	}

	for _, v := range poll.Voters {
		if v == voterKey || v == strings.TrimPrefix(voterKey, "user:") || v == strings.TrimPrefix(voterKey, "guest:") {
			return nil, errors.New("already voted")
		}
	}

	if len(poll.Votes) <= optionIndex {
		poll.Votes = make([]int, len(poll.Options))
	}

	poll.Votes[optionIndex]++
	poll.Voters = append(poll.Voters, voterKey)
	m.polls[pollID] = poll

	return &poll, nil
}

func (m *memoryStore) ClosePoll(pollID string, userID string) (*models.Poll, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	poll, exists := m.polls[pollID]
	if !exists {
		return nil, errors.New("poll not found")
	}

	if poll.CreatedBy != userID {
		return nil, errors.New("unauthorized: only creator can close")
	}

	if poll.Status == "closed" {
		return nil, errors.New("already closed")
	}

	poll.Status = "closed"
	m.polls[pollID] = poll
	return &poll, nil
}
