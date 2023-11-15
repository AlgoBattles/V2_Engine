const expresss = require('express');
const router = expresss.Router();

//Jobs to Run
const { Job } = require('../job');



function get_job({language, args, code}){
    return new Promise((resolve, reject)=> {
        if (!language || typeof language !== 'string'){
            reject({
                message: "Language needs to be a string",
            })
        }

        if (!code.content || typeof code.content !== 'string'){
            reject({message: "Code needs to be a string"})
        }
        resolve(new Job({language, args, code}))
    })
}

router.post('/execute', async (req,res)=>{
    let job;
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
        return res.status(500).send(e);
    } finally {
        try{
            await job.cleanup();
        } catch(e){
            return res.status(500).send(e)
        }
    }
    
})
   

module.exports = router;
