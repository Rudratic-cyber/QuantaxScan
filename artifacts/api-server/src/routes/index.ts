import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import scansRouter from "./scans";
import communityRouter from "./community";
import statsRouter from "./stats";
import demoRouter from "./demo";
import githubRouter from "./github";
import chatRouter from "./chat";
import reportsRouter from "./reports";
import reportPacksRouter from "./report-packs";
import inventoryRouter from "./inventory";
import otFleetsRouter from "./ot-fleets";
import vendorAssessmentsRouter from "./vendor-assessments";
import credentialsRouter from "./credentials";
import discoveryRouter from "./discovery";
import collectionSchedulesRouter from "./collection-schedules";
import driftRouter from "./drift";
import authRouter from "./auth";
import divisionsRouter from "./divisions";
import waiversRouter from "./waivers";
// P1 — credentialed collectors. Each gets its own file under `routes/collectors/`
// rather than another handler in `routes/projects.ts`, per §6.3.
import kmsPollRouter from "./collectors/kms-poll";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(divisionsRouter);
router.use(projectsRouter);
router.use(scansRouter);
router.use(communityRouter);
router.use(statsRouter);
router.use(demoRouter);
router.use(githubRouter);
router.use(chatRouter);
router.use(reportsRouter);
router.use(reportPacksRouter);
router.use(inventoryRouter);
router.use(otFleetsRouter);
router.use(vendorAssessmentsRouter);
router.use(credentialsRouter);
router.use(discoveryRouter);
router.use(collectionSchedulesRouter);
router.use(driftRouter);
router.use(waiversRouter);
router.use(kmsPollRouter);

export default router;
