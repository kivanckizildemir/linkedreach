import dotenv from 'dotenv'
dotenv.config()

import './linkedinAction.worker'
import './qualify.worker'
import './sequenceRunner.worker'
import { startScheduler } from './scheduler'
import { startWarmupWorker } from './warmup.worker'
import { startInboxPoller } from './inboxPoller.worker'
import './salesNavScraper.worker'

startScheduler()
startWarmupWorker()
startInboxPoller()
console.log('All workers started')
