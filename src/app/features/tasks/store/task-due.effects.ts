import { inject, Injectable } from '@angular/core';
import { createEffect } from '@ngrx/effects';
import {
  debounceTime,
  filter,
  first,
  map,
  switchMap,
  tap,
  withLatestFrom,
} from 'rxjs/operators';
import { GlobalTrackingIntervalService } from '../../../core/global-tracking-interval/global-tracking-interval.service';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import { Store } from '@ngrx/store';
import { selectOverdueTasksOnToday } from './task.selectors';
import { DataInitStateService } from '../../../core/data-init/data-init-state.service';
import { SyncWrapperService } from '../../../imex/sync/sync-wrapper.service';
import { selectTodayTaskIds } from '../../work-context/store/work-context.selectors';
import { AddTasksForTomorrowService } from '../../add-tasks-for-tomorrow/add-tasks-for-tomorrow.service';

@Injectable()
export class TaskDueEffects {
  private _store$ = inject(Store);
  private _globalTrackingIntervalService = inject(GlobalTrackingIntervalService);
  private _dataInitStateService = inject(DataInitStateService);
  private _syncWrapperService = inject(SyncWrapperService);
  private _addTasksForTomorrowService = inject(AddTasksForTomorrowService);

  private _dayChangeAfterInit$ =
    this._dataInitStateService.isAllDataLoadedInitially$.pipe(
      switchMap(() => this._globalTrackingIntervalService.todayDateStr$),
      switchMap(() => this._syncWrapperService.afterCurrentSyncDoneOrSyncDisabled$),
      // Add debounce to ensure sync has fully completed and status is updated
      debounceTime(1000),
      // Ensure we're not in the middle of another sync
      switchMap((dateStr) =>
        this._syncWrapperService.isSyncInProgress$.pipe(
          filter((inProgress) => !inProgress),
          first(),
          map(() => dateStr),
        ),
      ),
    );

  // NOTE: this gets a lot of interference from tagEffect.preventParentAndSubTaskInTodayList$:
  createRepeatableTasksAndAddDueToday$ = createEffect(
    () => {
      return this._dayChangeAfterInit$.pipe(
        tap(() => this._addTasksForTomorrowService.addAllDueToday()),
      );
    },
    {
      dispatch: false,
    },
  );

  // NOTE: this gets a lot of interference from tagEffect.preventParentAndSubTaskInTodayList$:
  removeOverdueFormToday$ = createEffect(() => {
    return this._dayChangeAfterInit$.pipe(
      switchMap(() => this._store$.select(selectOverdueTasksOnToday).pipe(first())),
      filter((overdue) => !!overdue.length),
      withLatestFrom(this._store$.select(selectTodayTaskIds)),
      // we do this to maintain the order of tasks
      map(([overdue, todayTaskIds]) =>
        TaskSharedActions.removeTasksFromTodayTag({
          taskIds: todayTaskIds.filter((id) => !!overdue.find((oT) => oT.id === id)),
        }),
      ),
    );
  });
}
