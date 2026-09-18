package realtime

import (
	"context"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var RedisClient *redis.Client

func ConnectRedis() {

	// Prefer REDIS_URL.
	// Example:
	// redis://username:password@host:6379
	// rediss://username:password@host:6379
	redisURL := strings.TrimSpace(
		os.Getenv("REDIS_URL"),
	)

	// Keep REDIS_ADDR as a fallback for local development.
	redisAddr := strings.TrimSpace(
		os.Getenv("REDIS_ADDR"),
	)

	var client *redis.Client

	if redisURL != "" {

		options, err := redis.ParseURL(redisURL)

		if err != nil {
			log.Println("Warning: Invalid REDIS_URL:", err)
			log.Println("Continuing without Redis.")
			return
		}

		// RESP2 is a safe choice for broad Redis compatibility.
		options.Protocol = 2

		client = redis.NewClient(options)

	} else if redisAddr != "" {

		client = redis.NewClient(&redis.Options{
			Addr:     redisAddr,
			Password: os.Getenv("REDIS_PASSWORD"),
			DB:       0,
			Protocol: 2,
		})

	} else {
		log.Println("REDIS_URL / REDIS_ADDR is not set.")
		log.Println("Redis features are disabled.")
		return
	}

	ctx, cancel := context.WithTimeout(
		context.Background(),
		5*time.Second,
	)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		log.Println("Warning: Redis connection failed:", err)

		_ = client.Close()

		log.Println("Continuing without Redis.")
		return
	}

	RedisClient = client

	log.Println("Connected to Redis successfully.")
}

// --------------------------------------------------
// LIVE IN-MEMORY COUNTERS & CACHING VIA REDIS
// --------------------------------------------------

// InitPollLiveCounts initializes option counters in Redis hash for a newly created poll.
func InitPollLiveCounts(ctx context.Context, pollID string, numOptions int) {
	if RedisClient == nil || pollID == "" || numOptions <= 0 {
		return
	}

	voteKey := "poll:" + pollID + ":votes"
	fields := make(map[string]interface{}, numOptions)
	for i := 0; i < numOptions; i++ {
		fields[strconv.Itoa(i)] = 0
	}

	pipeline := RedisClient.TxPipeline()
	pipeline.HSet(ctx, voteKey, fields)
	pipeline.Expire(ctx, voteKey, 7*24*time.Hour)
	_, _ = pipeline.Exec(ctx)
}

// IncrementPollLiveVote atomically checks voter duplication, increments the vote count in Redis,
// and returns the updated counts slice.
func IncrementPollLiveVote(ctx context.Context, pollID string, optionIndex int, voterKey string, numOptions int) (updatedVotes []int, alreadyVoted bool, err error) {
	if RedisClient == nil {
		return nil, false, nil
	}

	votersKey := "poll:" + pollID + ":voters"
	voteKey := "poll:" + pollID + ":votes"

	// Check if voter already voted in Redis
	isMember, checkErr := RedisClient.SIsMember(ctx, votersKey, voterKey).Result()
	if checkErr == nil && isMember {
		return nil, true, nil
	}

	// Atomically add voter to set and increment option counter
	pipeline := RedisClient.TxPipeline()
	saddCmd := pipeline.SAdd(ctx, votersKey, voterKey)
	pipeline.Expire(ctx, votersKey, 7*24*time.Hour)
	pipeline.HIncrBy(ctx, voteKey, strconv.Itoa(optionIndex), 1)
	pipeline.Expire(ctx, voteKey, 7*24*time.Hour)

	_, pipeErr := pipeline.Exec(ctx)
	if pipeErr != nil {
		return nil, false, pipeErr
	}

	// SAdd returns 0 if voter was already in the set (race condition check)
	if saddCmd.Val() == 0 {
		return nil, true, nil
	}

	// Retrieve updated tallies directly from Redis
	vals, getErr := RedisClient.HGetAll(ctx, voteKey).Result()
	if getErr != nil || len(vals) == 0 {
		return nil, false, nil
	}

	updatedVotes = make([]int, numOptions)
	for i := 0; i < numOptions; i++ {
		if valStr, ok := vals[strconv.Itoa(i)]; ok {
			count, _ := strconv.Atoi(valStr)
			updatedVotes[i] = count
		}
	}

	return updatedVotes, false, nil
}

// GetPollLiveCounts retrieves the live in-memory vote tallies directly from Redis.
func GetPollLiveCounts(ctx context.Context, pollID string, numOptions int) ([]int, bool) {
	if RedisClient == nil || pollID == "" || numOptions <= 0 {
		return nil, false
	}

	voteKey := "poll:" + pollID + ":votes"
	vals, err := RedisClient.HGetAll(ctx, voteKey).Result()
	if err != nil || len(vals) == 0 {
		return nil, false
	}

	votes := make([]int, numOptions)
	for i := 0; i < numOptions; i++ {
		if valStr, ok := vals[strconv.Itoa(i)]; ok {
			count, _ := strconv.Atoi(valStr)
			votes[i] = count
		}
	}

	return votes, true
}

// HasVoterVotedLive checks in-memory Redis set if the voter has already voted.
func HasVoterVotedLive(ctx context.Context, pollID string, voterKey string) bool {
	if RedisClient == nil || pollID == "" || voterKey == "" {
		return false
	}

	isMember, err := RedisClient.SIsMember(ctx, "poll:"+pollID+":voters", voterKey).Result()
	return err == nil && isMember
}