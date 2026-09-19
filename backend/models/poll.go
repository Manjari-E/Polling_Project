package models

import "go.mongodb.org/mongo-driver/v2/bson"

type Poll struct {
	ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
	Question  string        `json:"question" bson:"question"`
	Options   []string      `json:"options" bson:"options"`
	ImageUrls []string      `json:"imageUrls,omitempty" bson:"imageUrls,omitempty"`
	Votes     []int         `json:"votes" bson:"votes"`
	Voters    []string      `json:"-" bson:"voters,omitempty"`
	CreatedBy string        `json:"createdBy" bson:"createdBy"`
	Status    string        `json:"status" bson:"status"`
}