import { Router, type IRouter } from "express";
import healthRouter from "./health";
import criteriaRouter from "./criteria";
import companiesRouter from "./companies";
import jobsRouter from "./jobs";
import resumeRouter from "./resume";
import scoutRouter from "./scout";
import gmailRouter from "./gmail";

const router: IRouter = Router();

router.use(healthRouter);
router.use(criteriaRouter);
router.use(companiesRouter);
router.use(jobsRouter);
router.use(resumeRouter);
router.use(scoutRouter);
router.use(gmailRouter);

export default router;
