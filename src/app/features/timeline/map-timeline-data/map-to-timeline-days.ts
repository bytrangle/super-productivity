import { Task, TaskCopy, TaskPlanned, TaskWithoutReminder } from '../../tasks/task.model';
import { TaskRepeatCfg } from '../../task-repeat-cfg/task-repeat-cfg.model';
import {
  BlockedBlock,
  BlockedBlockByDayMap,
  BlockedBlockType,
  TimelineCalendarMapEntry,
  TimelineDay,
  TimelineLunchBreakCfg,
  TimelineViewEntry,
  TimelineViewEntrySplitTaskContinued,
  TimelineViewEntryTask,
  TimelineWorkStartEndCfg,
} from '../timeline.model';
import { PlannerDayMap } from '../../planner/planner.model';
import { getDateTimeFromClockString } from '../../../util/get-date-time-from-clock-string';
import { createSortedBlockerBlocks } from './create-sorted-blocker-blocks';
import { getWorklogStr } from '../../../util/get-work-log-str';
import {
  TIMELINE_MOVEABLE_TYPES,
  TIMELINE_VIEW_TYPE_ORDER,
  TimelineViewEntryType,
} from '../timeline.const';
import moment from 'moment/moment';
import {
  getTimeLeftForTask,
  getTimeLeftForTasks,
} from '../../../util/get-time-left-for-task';
import { msLeftToday } from '../../../util/ms-left-today';
import { createTimelineViewEntriesForNormalTasks } from './create-timeline-view-entries-for-normal-tasks';
import { insertBlockedBlocksViewEntries } from './map-to-timeline-view-entries';

// const debug = (...args: any) => console.log(...args);
const debug = (...args: any): void => undefined;

export const mapToTimelineDays = (
  dayDates: string[],
  tasks: Task[],
  scheduledTasks: TaskPlanned[],
  scheduledTaskRepeatCfgs: TaskRepeatCfg[],
  calenderWithItems: TimelineCalendarMapEntry[],
  currentId: string | null,
  plannerDayMap: PlannerDayMap,
  workStartEndCfg?: TimelineWorkStartEndCfg,
  lunchBreakCfg?: TimelineLunchBreakCfg,
  now: number = Date.now(),
): TimelineDay[] => {
  let startTime = now;
  const plannerDayKeys = Object.keys(plannerDayMap);
  const plannerDayTasks = plannerDayKeys
    .map((key) => {
      return plannerDayMap[key];
    })
    .flat();

  if (
    !tasks.length &&
    !scheduledTasks.length &&
    !scheduledTaskRepeatCfgs.length &&
    !calenderWithItems.length &&
    !plannerDayTasks.length
  ) {
    return [];
  }

  if (workStartEndCfg) {
    const startTimeToday = getDateTimeFromClockString(workStartEndCfg.startTime, now);
    if (startTimeToday > now) {
      startTime = startTimeToday;
    }
  }

  const initialTasks: Task[] = currentId
    ? resortTasksWithCurrentFirst(currentId, tasks)
    : tasks;

  const nonScheduledTasks: TaskWithoutReminder[] = initialTasks.filter(
    (task) => !(task.reminderId && task.plannedAt),
  ) as TaskWithoutReminder[];

  const blockerBlocksDayMap = createBlockedBlocksByDayMap(
    scheduledTasks,
    scheduledTaskRepeatCfgs,
    calenderWithItems,
    workStartEndCfg,
    lunchBreakCfg,
    now,
  );
  console.log({ blockerBlocksDayMap });

  const v = createTimelineDays(
    nonScheduledTasks,
    dayDates,
    plannerDayMap,
    blockerBlocksDayMap,
    workStartEndCfg,
    now,
  );
  console.log(v);

  return v;
};

export const createTimelineDays = (
  nonScheduledTasks: TaskWithoutReminder[],
  dayDates: string[],
  plannerDayMap: PlannerDayMap,
  blockerBlocksDayMap: BlockedBlockByDayMap,
  workStartEndCfg: TimelineWorkStartEndCfg | undefined,
  now: number,
): TimelineDay[] => {
  let viewEntriesForNextDay: TimelineViewEntry[] = [];
  let regularTasksLeftForDay: TaskWithoutReminder[] = nonScheduledTasks;

  const v: TimelineDay[] = dayDates.map((dayDate, i) => {
    const nextDayStartDate = new Date(dayDate);
    nextDayStartDate.setHours(24, 0, 0, 0);
    const nextDayStart = nextDayStartDate.getTime();
    const todayStart = new Date(dayDate);
    todayStart.setHours(0, 0, 0, 0);

    // TODO can all be optimized in terms of performance
    let startTime = i == 0 ? now : todayStart.getTime();
    if (workStartEndCfg) {
      const startTimeToday = getDateTimeFromClockString(
        workStartEndCfg.startTime,
        new Date(dayDate),
      );
      if (startTimeToday > now) {
        startTime = startTimeToday;
      }
    }

    const blockerBlocksForDay = blockerBlocksDayMap[dayDate] || [];
    const taskPlannedForDay = plannerDayMap[dayDate] || [];
    // TODO also add split task value
    const timeLeftForRegular = getTimeLeftForTasks(regularTasksLeftForDay);
    const nonScheduledBudgetForDay = getBudgetLeftForDay(
      blockerBlocksForDay,
      i === 0 ? now : undefined,
    );

    let viewEntries: TimelineViewEntry[] = [];
    if (nonScheduledBudgetForDay - timeLeftForRegular > 0) {
      // we have enough budget for ALL nonScheduled and some left for other tasks like the planned for day ones
      viewEntries = createViewEntriesForDay(
        now,
        regularTasksLeftForDay,
        blockerBlocksForDay,
        viewEntriesForNextDay,
      );
      regularTasksLeftForDay = [];
      // TODO  we sort the planned for today ones if any and split them as needed and create overdue tasks
    } else if (nonScheduledBudgetForDay - timeLeftForRegular === 0) {
      // no splitting is needed, all tasks planed for today are OVER_BUDGET
      regularTasksLeftForDay = [];
      // TODO
    } else {
      // we have not enough budget left  for all remaining regular tasks, so we cut them off for the next today
      // AND we sort in the tasks that were planned for today ALL as OVER_BUDGET
      viewEntries = createViewEntriesForDay(
        startTime,
        regularTasksLeftForDay,
        blockerBlocksForDay,
        viewEntriesForNextDay,
      );
      regularTasksLeftForDay = getRemainingTasks(
        regularTasksLeftForDay,
        nonScheduledBudgetForDay,
      );
    }

    const viewEntriesToRenderForDay: TimelineViewEntry[] = [];
    viewEntriesForNextDay = [];
    viewEntries.forEach((entry) => {
      if (entry.start >= nextDayStart) {
        if (
          entry.type === TimelineViewEntryType.SplitTaskContinuedLast ||
          entry.type === TimelineViewEntryType.SplitTaskContinued
        ) {
          viewEntriesForNextDay.push(entry);
        }
      } else {
        viewEntriesToRenderForDay.push(entry);
      }
    });

    console.log({
      dayDate,
      startTime: new Date(startTime),
      viewEntriesForNextDay,
      regularTasksLeftForDay,
      blockerBlocksForDay,
      taskPlannedForDay,
      timeLeftForRegular,
      nonScheduledBudgetForDay,
      nonScheduledBudgetForDay2: nonScheduledBudgetForDay / 60 / 60 / 1000,
    });

    return {
      dayDate,
      entries: viewEntriesToRenderForDay,
      isToday: i === 0,
    };
  });
  return v;
};

const getRemainingTasks = (
  nonScheduledTasks: TaskWithoutReminder[],
  budget: number,
): TaskWithoutReminder[] => {
  let count = 0;
  return nonScheduledTasks.filter((task) => {
    if (count < budget) {
      count += getTimeLeftForTask(task);
      return false;
    }
    return true;
  });
};

export const createViewEntriesForDay = (
  startTime: number,
  nonScheduledTasksForDay: TaskWithoutReminder[],
  blockedBlocksForDay: BlockedBlock[],
  prevDayViewEntries: TimelineViewEntry[],
): TimelineViewEntry[] => {
  // const viewEntries: TimelineViewEntry[] = prevDayViewEntries.concat(
  //   createTimelineViewEntriesForNormalTasks(startTime, nonScheduledTasksForDay),
  // );
  const viewEntries: TimelineViewEntry[] = createTimelineViewEntriesForNormalTasks(
    startTime,
    nonScheduledTasksForDay,
  );

  insertBlockedBlocksViewEntries(
    viewEntries as TimelineViewEntryTask[],
    blockedBlocksForDay,
    0, // TODO remove form insertBlockedBlocksViewEntries
  );

  // CLEANUP
  // -------
  viewEntries.sort((a, b) => {
    if (a.start - b.start === 0) {
      return TIMELINE_VIEW_TYPE_ORDER[a.type] - TIMELINE_VIEW_TYPE_ORDER[b.type];
    }
    return a.start - b.start;
  });

  // TODO add current handling
  // Move current always first and let it appear as now
  // if (currentId) {
  //   const currentIndex = viewEntries.findIndex((ve) => ve.id === currentId);
  //   // NOTE: might not always be available here
  //   if (currentIndex !== -1) {
  //     viewEntries[currentIndex].start = now - 600000;
  //     viewEntries.splice(0, 0, viewEntries[currentIndex]);
  //     viewEntries.splice(currentIndex + 1, 1);
  //   } else {
  //     debug(viewEntries);
  //     console.warn('View Entry for current not available');
  //   }
  // }

  return viewEntries;
};

// TODO unit test
export const getBudgetLeftForDay = (
  blockerBlocksForDay: BlockedBlock[],
  nowIfToday?: number,
): number => {
  if (nowIfToday) {
    return blockerBlocksForDay.reduce((acc, currentValue) => {
      const diff =
        Math.max(nowIfToday, currentValue.end) - Math.max(nowIfToday, currentValue.start);
      return acc - diff;
    }, msLeftToday(nowIfToday));
  }

  return blockerBlocksForDay.reduce(
    (acc, currentValue) => {
      return acc - (currentValue.end - currentValue.start);
    },
    24 * 60 * 60 * 1000,
  );
};

const createBlockedBlocksByDayMap = (
  scheduledTasks: TaskPlanned[],
  scheduledTaskRepeatCfgs: TaskRepeatCfg[],
  icalEventMap: TimelineCalendarMapEntry[],
  workStartEndCfg?: TimelineWorkStartEndCfg,
  lunchBreakCfg?: TimelineLunchBreakCfg,
  now?: number,
): BlockedBlockByDayMap => {
  const allBlockedBlocks = createSortedBlockerBlocks(
    scheduledTasks,
    scheduledTaskRepeatCfgs,
    icalEventMap,
    workStartEndCfg,
    lunchBreakCfg,
    now,
  );
  const blockedBlocksByDay: BlockedBlockByDayMap = {};
  allBlockedBlocks.forEach((block) => {
    const dayStartDate = getWorklogStr(block.start);
    const dayEndBoundary = new Date(block.start).setHours(24, 0, 0, 0);

    if (!blockedBlocksByDay[dayStartDate]) {
      blockedBlocksByDay[dayStartDate] = [];
    }
    blockedBlocksByDay[dayStartDate].push({
      ...block,
      end: Math.min(dayEndBoundary, block.end),
    });

    // TODO handle case when blocker block spans multiple days
    // const dayEndDate = getWorklogStr(block.end);
    // if (dayStartDate !== dayEndDate) {
    //   const dayStartBoundary2 = new Date(block.end).setHours(0, 0, 0, 0);
    //   const dayEndBoundary2 = new Date(block.end).setHours(24, 0, 0, 0);
    //
    //   if (!blockedBlocksByDay[dayEndDate]) {
    //     blockedBlocksByDay[dayEndDate] = [];
    //   }
    //   blockedBlocksByDay[dayEndDate].push({
    //     ...block,
    //     start: dayStartBoundary2,
    //     end: Math.min(dayEndBoundary2, block.end),
    //   });
    // }
  });

  return blockedBlocksByDay;
};

const resortTasksWithCurrentFirst = (currentId: string, tasks: Task[]): Task[] => {
  let newTasks = tasks;
  const currentTask = tasks.find((t) => t.id === currentId);
  if (currentTask) {
    newTasks = [currentTask, ...tasks.filter((t) => t.id !== currentId)] as Task[];
  }
  return newTasks;
};
