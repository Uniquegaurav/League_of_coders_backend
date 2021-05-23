const users = [];
const creatorUsers = []
// users containing all the users {with socketid username roomid}
// creatorUsers containing all users who created a room { with socketid username roomid roomdata}

// for starting a test and checking if test started or not
const test = [];
export const addTestStart  = (roomid) =>{
    test.push(roomid);
}
export const checkTestStart = (roomid) =>{
    test.map(i =>{console.log(i)});
    return test.includes(roomid);
}
export const removeTest = (roomid) =>{
    const index = test.indexOf(roomid);
    if (index > -1) {
          test.splice(index, 1);
     }
}

export const createUser = ({socketid,roomid,username,data,timeinterval}) =>{

    // this function will create a user as creatorUser and add that user to normal users as well
    const existingroomid  = creatorUsers.find((user) => user.roomid === roomid);
    if(existingroomid){
        return {error : 'Already room exists with same room id'};
    }
    const creatorUser = {socketid,roomid,username,data,timeinterval};
    const user = {socketid,roomid,username};
    creatorUsers.push(creatorUser);
    users.push(user);
    return {creatorUser};
}
export const joinUser = ({socketid,roomid,username}) =>{

    // this function will find if any creator user created a room with his room id
    // if created then it will add that user to all users array and return that user
    // creatorUsers.map((i)=>{console.log(i.socketid,typeof(i.roomid),i.roomid,i.username,i.data)});
    // console.log(typeof(roomid),roomid);
    const existingroomid  = creatorUsers.find((user) => user.roomid === roomid);
    if(!existingroomid){
        return {error : 'No room exists with this room id'};
    }
    const user = {socketid,roomid,username};
    users.push(user);
    return {user};
}
export const removeUser = (socketid)=>{
    // removing an user from all users array and if it is a creator user we are removing that user
    // from creator user array as well

    const index = users.findIndex((user) => user.socketid ===socketid);
    if(index != -1){
            const index2 = creatorUsers.findIndex((user) => user.socketid ===socketid);
            if(index2 != -1){
                const creator =  creatorUsers.splice(index2,1)[0];
                removeTest(creator.roomid);
            }
        return users.splice(index,1)[0];
    }
}

export const getUser = (socketid) => users.find((user) => user.socketid===socketid); // finding a user with his socket id
export const getRoom = (roomid) => creatorUsers.find((user) => user.roomid===roomid); // finding a room in creator users

export const getUsersInRoom = (roomid) => users.filter((user)=> user.roomid === roomid); // finding all users in a room