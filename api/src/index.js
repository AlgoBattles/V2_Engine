const express = require("express");
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs')
const body_parser = require('body-parser')


//Router
const execution_engine = require('./api/execution_engine');

const app = express();

const JOB_DIRECTORY = 'jobs';
const DATA_DIRECTORY = '/V2_Engine';

(async () => {
    let data_path = path.join(DATA_DIRECTORY,JOB_DIRECTORY);
    if (!fss.existsSync(data_path)) {
        try {
            //make the directory
            // fss.mkdirSync(data_path);
            await fs.mkdir(data_path, { recursive: true });
            await fs.chmod(data_path, 0o711);
            
        } catch(e) {
            console.log(e)
        }
    }

    fss.chmodSync(path.join(DATA_DIRECTORY,JOB_DIRECTORY), 0o711)

    //Express Server Stuff
    app.use(body_parser.urlencoded({extended: true}))
    app.use(body_parser.json())

    //Error Handler
    app.use((err,req,res,next)=>{
        return res.status(400).send({stack: err.stack})
    })

    app.use('/api/v1', execution_engine);

    app.get('/', (req,res,next)=>{
        return res.status(200).send({message: "Engine is Running"})
    })

    app.use((req, res, next)=>{
        return res.status(404).send({message:'Not Found'})
    })

    app.listen(8080, ()=> {
        console.log("Server has been started!")
    })
})()
