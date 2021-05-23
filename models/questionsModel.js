import mongoose from "mongoose";

const questionsModel = mongoose.Schema({

    questionId : Number,
    name : String,
    likeCount: {
        type: Number,
        default: 0,
    },
});

const Questions =  mongoose.model('Questions',questionsModel);
export default Questions ;