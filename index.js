import express from 'express';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv'
import postRoutes from './routes/posts.js';
import userRoutes from './routes/users.js';
// import questionRoutes from './routes/questions.js';
import { Server } from 'socket.io';
import { addTestStart, checkTestStart, createUser, removeTest,
       getRoom, getUser, getUsersInRoom, joinUser, removeUser } from './socketUsers/socketUsers.js';

const app = express();
dotenv.config();

app.use(bodyParser.json({limit : "30mb",extended : true}));
app.use(bodyParser.urlencoded({limit : "30mb",extended : true}));
app.use(cors());
app.options('*', cors());

// adding post routes
app.use('/posts',postRoutes);

//adding userROutes
app.use('/users',userRoutes);

// adding question Routes
// app.use('/questions',questionRoutes);
 app.get('/' ,(req,res) =>{
        res.send('Welcome to league of coders website')
 })

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT,()=> console.log(`Server running on port : ${PORT}`))
mongoose.connect(process.env.CONNECTION_URL ,{useNewUrlParser : true ,useUnifiedTopology : true})
       .then(()=>console.log('Database connected Successfully'))
       .catch((error) => console.log(error.message));

    
mongoose.set('useFindAndModify',false);

const io = new Server(server,cors());
io.options('*', cors());
io.on('connection',(socket) =>{
       console.log('We have a new Connection')

       socket.on('create', ({roomid,username,data,timeinterval}) =>{

              console.log('increate',roomid,username,timeinterval);
              const {error,creatorUser} = createUser({socketid : socket.id,roomid,username,data,timeinterval});
              if(error) return callback(error);

              socket.join(creatorUser.roomid);
              socket.emit('data' ,{data : creatorUser.data,timeinterval : creatorUser.timeinterval})

              const usersInRoom = getUsersInRoom(roomid);
              io.in(roomid).emit('users' ,usersInRoom);  
       
       })
       socket.on('joinrequest' ,({roomid}) =>{

              
              let response  = 'canjoin';
              const roomJoin = getRoom(roomid);
              if(roomJoin){
                     const teststarted = checkTestStart(roomid);
                     if(teststarted){
                            response = "Can't join now !!!test already started";
                     }
              }else{
                     response = "No room exists with this room id";
              }
              socket.emit('joinresponse' ,{response});
              console.log('join requesst with this' ,roomid ,response);
              
       })
       socket.on('join' ,({roomid,username},callback) =>{

              const {error,user} = joinUser({socketid : socket.id,roomid,username});
              console.log(error)
              if(error) return callback(error);
              const roomJoin = getRoom(roomid);
              socket.join(roomJoin.roomid);
              socket.emit('data' ,{data : roomJoin.data,timeinterval : roomJoin.timeinterval})

              const usersInRoom = getUsersInRoom(roomid);
              io.in(roomid).emit('users' ,usersInRoom);  
              callback();      
       })

       socket.on('starttest' ,(roomid,callback) =>{
              const teststarted = checkTestStart(roomid);
              if(teststarted){
                     return callback("Lobby is in progress..can't join now"); 
              }
              addTestStart(roomid);
              io.in(roomid).emit('starttest',teststarted); 
              callback() 
       })
       socket.on('disconnect', ()=>{
             
              const user = removeUser(socket.id);
              if(user){
                     console.log(user,'had left');
                     io.to(user.roomid).emit('users' ,getUsersInRoom(user.roomid));
              }
       })
})