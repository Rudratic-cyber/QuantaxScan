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
import inventoryRouter from "./inventory";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectsRouter);
router.use(scansRouter);
router.use(communityRouter);
router.use(statsRouter);
router.use(demoRouter);
router.use(githubRouter);
router.use(chatRouter);
router.use(reportsRouter);
router.use(inventoryRouter);

export default router;
