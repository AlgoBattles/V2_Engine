const expresss = require('express');
const router = expresss.Router();

//Jobs to Run
const {Job} = require('../job')

type Job_Info = {
    language: string,
    args: any,
    code: string
}

function get_job({language, args, code}: Job_Info){
    return new Promise((resolve, reject)=> {
        if (!language || typeof language !== 'string'){
            reject({
                message: "Language needs to be a string",
            })
        }

        if (!code || typeof code !== 'string'){
            reject({message: "Code needs to be a string"})
        }

        resolve(new Job({language, args, code}))
    })
}

router.post('/execute', async (req:any,res:any)=>{
    let job: any;
    try{
        job = await get_job(req.body);
    } catch(e) {
        return res.status(400).json(e);
    }

    try {
        await job.prime();

        let result = await job.execute();

        if (result.run === undefined){
            result.run = result.compile
        }
        return res.status(200).json(result);   
    } catch(e) {
        return res.status(500).send();
    } finally {
        try{
            await job.cleanup();
        } catch(e){
            return res.status(500).send()
        }
    }
    
})
   

