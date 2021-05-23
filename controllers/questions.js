
import Questions from '../models/questionsModel.js'
import express from 'express';
import mongoose from 'mongoose';

export const likeQuestion = async(req,res) =>{

    console.log('liking a question')
    const {id} = req.params;
    const { likevalue } = req.body;
        try {
            const newQuestions = new Questions({id,likevalue});
            newQuestions.save()
             const query = { questionId:  parseInt(id)};
             const question  = await  Questions.findOne(query).exec();
             const updatedQuestion  =  await Questions.findOneAndUpdate(query, {likeCount: question.likeCount + parseInt(likevalue)}, {upsert : true} , { new: true });
             res.json(updatedQuestion);
        } catch (error) {

            res.status(404).send(`No question with id: ${id}`);
        }
}
