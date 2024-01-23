const {v4: uuidv4} = require('uuid');
const cp = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { Console } = require('console');


const job_states = {
    READY: Symbol('Ready to be primed'),
    PRIMED: Symbol('Primed and ready for execution'),
    EXECUTED: Symbol('Executed and ready for cleanup'),
};

let uid = 0;
let gid = 0;

let remaining_job_spaces = 64;
let job_queue = [];


class Job {
    #active_timeouts;
    #active_parent_processes;

    constructor( {language, code, args} ) {
        try{
            this.uuid = uuidv4();


            this.runtime = language;
    
            //Must be an object with the content and the name
            this.code = code
    
            this.args = args;
         
    
            this.#active_timeouts = [];
            this.#active_parent_processes = [];
    
            this.timeouts = 3000;
    
            this.uid = 1001 + uid;
            this.gid = 1001 + gid;
    
            uid++;
            gid++;
    
            uid %= 1500 - 1001 + 1;
            gid %= 1500 - 1001 + 1;
    
            this.python_test_code = "\nimport sys\nimport json\nglobfunc=globals()[\""+this.code.name+"\"]\ntestCases = json.loads(sys.argv[1])\nresults=[]\nfor case in testCases:\n    results.append([globfunc(*case[0]),case[1]])\nprint(results)"
            this.javascript_test_code = `let testCases = JSON.parse(process.argv[2]); let results=[];for (let i=0;i<testCases.length;i++){results.push([`+this.code.name+'(...testCases[i][0]),testCases[i][1]])};console.log(JSON.stringify(results));'
            this.state = job_states.READY;
    
            this.dir = path.join(
                '/V2_Engine',
                'jobs',
                this.uuid
            );
        } catch(e){
            console.log(e)
        }
       
    }

    async prime() {
        try{
            if (remaining_job_spaces < 1) {
                await new Promise(resolve => {
                    job_queue.push(resolve);
                });
            }
           
            remaining_job_spaces--;
    
    
            //Transferring Ownership
    
            await fs.mkdir(this.dir, { mode: 0o700 });
            await fs.chown(this.dir, this.uid, this.gid);
    
        
            const file_path = path.join(this.dir, this.code.name);
            const rel = path.relative(this.dir, file_path);
            this.code.content += this.runtime === 'python' ? this.python_test_code: this.javascript_test_code;
            const file_content = Buffer.from(this.code.content, 'utf-8');
    
            if (rel.startsWith('..'))
                throw Error(
                    `File path "${this.code.name}" tries to escape parent directory: ${rel}`
                );
    
            await fs.mkdir(path.dirname(file_path), {
                recursive: true,
                mode: 0o700,
            });
            await fs.chown(path.dirname(file_path), this.uid, this.gid);
            
            await fs.writeFile(file_path, file_content);
            await fs.chown(file_path, this.uid, this.gid);
            
            //Job is now primed
            this.state = job_states.PRIMED;
        } catch(e) {
            console.log(e)
        }
       

        
    }



    //Clear Active Timeouts
    exit_cleanup() {
        for (const timeout of this.#active_timeouts) {
            clearTimeout(timeout);
        }
        this.#active_timeouts = [];
        

        this.cleanup_processes();
        
    }

    close_cleanup() {
        for (const proc of this.#active_parent_processes) {
            proc.stderr.destroy();
            if (!proc.stdin.destroyed) {
                proc.stdin.end();
                proc.stdin.destroy();
            }
            proc.stdout.destroy();
        }
        this.#active_parent_processes = [];
        
    }

    async safe_call(file, args, timeout) {
        return new Promise((resolve, reject) => {
            try{
                const prlimit = [
                    'prlimit',
                    '--nproc=' + 64,
                    '--nofile=' + 1024,
                    '--fsize=' + 10000000,
                ];
    
                const timeout_call = [
                    'timeout',
                    '-s',
                    '9',
                    Math.ceil(timeout / 1000),
                ];
        
                const proc_call = [
                    'nice',
                    ...timeout_call,
                    ...prlimit,
                    'bash',
                    file,
                    ...args,
                ];
    
                var stdout = '';
                var stderr = '';
                var output = '';
    
                const proc = cp.spawn(proc_call[0], proc_call.splice(1), {
                    stdio: 'pipe',
                    cwd: this.dir,
                    uid: this.uid,
                    gid: this.gid,
                    detached: true, //give this process its own process group
                });
    
                this.#active_parent_processes.push(proc);
    
              
                proc.stdin.end();
                proc.stdin.destroy();
               
    
                const kill_timeout =
                    (timeout >= 0 &&
                        setTimeout(async _ => {
                            try {
                                process.kill(proc.pid, 'SIGKILL');
                            }
                            catch (e) {
                                // Could already be dead and just needs to be waited on
                               console.log(e)
                            }
                        }, timeout)) ||
                    null;
                this.#active_timeouts.push(kill_timeout);
    
                proc.stderr.on('data', async data => {
                   if (stderr.length > 1024) {
                        try {
                            process.kill(proc.pid, 'SIGKILL');
                        }
                        catch (e) {
                            // Could already be dead and just needs to be waited on
                           console.log("Error while killing process.")
                        }
                    } else {
                        stderr += data;
                        output += data;
                    }
                });
    
                proc.stdout.on('data', async data => {
                    if (stdout.length > this.runtime.output_max_size) {
                        console.log("Length Exceeded")
                        try {
                            process.kill(proc.pid, 'SIGKILL');
                        }
                        catch (e) {
                            // Could already be dead and just needs to be waited on
                            console.log(e)
                        }
                    } else {
                        stdout += data;
                        output += data;
                    }
                });
    
                proc.on('exit', () => this.exit_cleanup());
    
                proc.on('close', (code, signal) => {
                    this.close_cleanup();
    
                    resolve({ stdout, stderr, code, signal, output });
                });
    
                proc.on('error', err => {
                    this.exit_cleanup();
                    this.close_cleanup();
    
                    reject({ error: err, stdout, stderr, output });
                });
            } catch(e){
                console.log(e)
            }
            
        });
    }

    async execute() {
        try{
            if (this.state !== job_states.PRIMED) {
            throw new Error(
                'Job must be in primed state, current state: ' +
                this.state.toString()
            );
        }

        //Running Code
        let run = await this.safe_call(
            //This Run Bash file needs to be based off the language
            path.join(__dirname, `./scripts/${this.runtime}.bash`),
            [this.code.name, this.args],
            this.timeouts,
        );
            
        this.state = job_states.EXECUTED;

        return {
            run,
            language: this.runtime
        };
        } catch(e) {
            console.log(e)
        }
        
    }

    cleanup_processes(dont_wait = []) {
        let processes = [1];
        const to_wait = [];
       //Cleaning up 
        while (processes.length > 0) {
            processes = [];

            const proc_ids = fss.readdirSync('/proc');

            processes = proc_ids.map(proc_id => {
                if (isNaN(proc_id)) return -1;
                try {
                    const proc_status = fss.readFileSync(
                        path.join('/proc', proc_id, 'status')
                    );
                    const proc_lines = proc_status.to_string().split('\n');
                    const state_line = proc_lines.find(line =>
                        line.starts_with('State:')
                    );
                    const uid_line = proc_lines.find(line =>
                        line.starts_with('Uid:')
                    );
                    const [_, ruid, euid, suid, fuid] = uid_line.split(/\s+/);

                    const [_1, state, user_friendly] = state_line.split(/\s+/);

                    const proc_id_int = parse_int(proc_id);

                    // Skip over any processes that aren't ours.
                    if (ruid != this.uid && euid != this.uid) return -1;

                    if (state == 'Z') {
                        // Zombie process, just needs to be waited, regardless of the user id
                        if (!to_wait.includes(proc_id_int))
                            to_wait.push(proc_id_int);

                        return -1;
                    }
                    // We should kill in all other state (Sleep, Stopped & Running)

                    return proc_id_int;
                } catch {
                    return -1;
                }

                return -1;
            });

            processes = processes.filter(p => p > 0);

           

            for (const proc of processes) {
                // First stop the processes, but keep their resources allocated so they cant re-fork
                try {
                    process.kill(proc, 'SIGSTOP');
                } catch (e) {
                    // Could already be dead
                    console.log(e)
                }
            }

            for (const proc of processes) {
                // Then clear them out of the process tree
                try {
                    process.kill(proc, 'SIGKILL');
                } catch (e) {
                    // Could already be dead and just needs to be waited on
                    console.log(e)
                }

                to_wait.push(proc);
            }
        }

       

        for (const proc of to_wait) {
            if (dont_wait.includes(proc)) continue;

            wait_pid(proc);
        }

        
    }

    async cleanup_filesystem() {
        for (const clean_path of ['/dev/shm', '/run/lock', '/tmp', '/var/tmp']) {
            const contents = await fs.readdir(clean_path);

            for (const file of contents) {
                const file_path = path.join(clean_path, file);

                try {
                    const stat = await fs.stat(file_path);

                    if (stat.uid === this.uid) {
                        await fs.rm(file_path, {
                            recursive: true,
                            force: true,
                        });
                    }
                } catch (e) {
                    // File was somehow deleted in the time that we read the dir to when we checked the file
                   console.log(e)
                }
            }
        }

        await fs.rm(this.dir, { recursive: true, force: true });
    }

    async cleanup() {
       

        this.exit_cleanup(); // Run process janitor, just incase there are any residual processes somehow
        this.close_cleanup();
        await this.cleanup_filesystem();

        remaining_job_spaces++;
        if (job_queue.length > 0) {
            job_queue.shift()();
        }
    }
}

module.exports = {
    Job,
};

