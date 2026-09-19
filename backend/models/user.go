package models

import "go.mongodb.org/mongo-driver/v2/bson"

type User struct {
	ID           bson.ObjectID `json:"id" bson:"_id,omitempty"`
	Name         string        `json:"name" bson:"name"`
	Email        string        `json:"email" bson:"email"`
	Password     string        `json:"-" bson:"password,omitempty"`
	AuthProvider string        `json:"authProvider,omitempty" bson:"authProvider,omitempty"`
	Avatar       string        `json:"avatar,omitempty" bson:"avatar,omitempty"`
}