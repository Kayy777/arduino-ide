import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import type {
  Command,
  CommandContribution,
  CommandRegistry,
} from '@theia/core/lib/common/command';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { deepClone, deepFreeze } from '@theia/core/lib/common/objects';
import type { Mutable } from '@theia/core/lib/common/types';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import {
  BoardDetails,
  BoardsService,
  ConfigOption,
  ConfigValue,
  Programmer,
  isBoardIdentifierChangeEvent,
  isProgrammer,
} from '../../common/protocol';
import { notEmpty } from '../../common/utils';
import type {
  StartupTask,
  StartupTaskProvider,
} from '../../electron-common/startup-task';
import { NotificationCenter } from '../notification-center';
import { BoardsServiceProvider } from './boards-service-provider';

@injectable()
export class BoardsDataStore
  implements
    FrontendApplicationContribution,
    StartupTaskProvider,
    CommandContribution
{
  @inject(ILogger)
  @named('store')
  private readonly logger: ILogger;
  @inject(BoardsService)
  private readonly boardsService: BoardsService;
  @inject(NotificationCenter)
  private readonly notificationCenter: NotificationCenter;
  // When `@theia/workspace` is part of the application, the workspace-scoped storage service is the default implementation, and the `StorageService` symbol must be used for the injection.
  // https://github.com/eclipse-theia/theia/blob/ba3722b04ff91eb6a4af6a571c9e263c77cdd8b5/packages/workspace/src/browser/workspace-frontend-module.ts#L97-L98
  // In other words, store the data (such as the board configs) per sketch, not per IDE2 installation. https://github.com/arduino/arduino-ide/issues/2240
  @inject(StorageService)
  private readonly storageService: StorageService;
  @inject(BoardsServiceProvider)
  private readonly boardsServiceProvider: BoardsServiceProvider;
  @inject(FrontendApplicationStateService)
  private readonly appStateService: FrontendApplicationStateService;

  private readonly onDidChangeEmitter =
    new Emitter<BoardsDataStoreChangeEvent>();
  private readonly toDispose = new DisposableCollection(
    this.onDidChangeEmitter
  );
  private _selectedBoardData: BoardsDataStoreChange | undefined;

  onStart(): void {
    this.toDispose.pushAll([
      this.boardsServiceProvider.onBoardsConfigDidChange((event) => {
        if (isBoardIdentifierChangeEvent(event)) {
          this.updateSelectedBoardData(event.selectedBoard?.fqbn);
        }
      }),
      this.notificationCenter.onPlatformDidInstall(async ({ item }) => {
        const boardsWithFqbn = item.boards
          .map(({ fqbn }) => fqbn)
          .filter(notEmpty);
        const changes: BoardsDataStoreChange[] = [];
        for (const fqbn of boardsWithFqbn) {
          const key = this.getStorageKey(fqbn);
          const storedData =
            await this.storageService.getData<BoardsDataStore.Data>(key);
          if (!storedData) {
            // if not previously value is available for the board, do not update the cache
            continue;
          }
          const details = await this.loadBoardDetails(fqbn);
          if (details) {
            const data = createDataStoreEntry(details);
            await this.storageService.setData(key, data);
            changes.push({ fqbn, data });
          }
        }
        if (changes.length) {
          this.fireChanged(...changes);
        }
      }),
    ]);

    Promise.all([
      this.boardsServiceProvider.ready,
      this.appStateService.reachedState('ready'),
    ]).then(() =>
      this.updateSelectedBoardData(
        this.boardsServiceProvider.boardsConfig.selectedBoard?.fqbn
      )
    );
  }

  private async getSelectedBoardData(
    fqbn: string | undefined
  ): Promise<BoardsDataStoreChange | undefined> {
    if (!fqbn) {
      return undefined;
    } else {
      const data = await this.getData(fqbn);
      if (data === BoardsDataStore.Data.EMPTY) {
        return undefined;
      }
      return { fqbn, data };
    }
  }

  private async updateSelectedBoardData(
    fqbn: string | undefined
  ): Promise<void> {
    this._selectedBoardData = await this.getSelectedBoardData(fqbn);
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(USE_INHERITED_DATA, {
      execute: async (arg: unknown) => {
        if (isBoardsDataStoreChange(arg)) {
          await this.setData(arg);
          this.fireChanged(arg);
        }
      },
    });
  }

  tasks(): StartupTask[] {
    if (!this._selectedBoardData) {
      return [];
    }
    return [
      {
        command: USE_INHERITED_DATA.id,
        args: [this._selectedBoardData],
      },
    ];
  }

  get onDidChange(): Event<BoardsDataStoreChangeEvent> {
    return this.onDidChangeEmitter.event;
  }

  async appendConfigToFqbn(
    fqbn: string | undefined
  ): Promise<string | undefined> {
    if (!fqbn) {
      return undefined;
    }
    const { configOptions } = await this.getData(fqbn);
    return ConfigOption.decorate(fqbn, configOptions);
  }

  async getData(fqbn: string | undefined): Promise<BoardsDataStore.Data> {
    if (!fqbn) {
      return BoardsDataStore.Data.EMPTY;
    }

    const key = this.getStorageKey(fqbn);
    const storedData = await this.storageService.getData<
      BoardsDataStore.Data | undefined
    >(key, undefined);
    if (BoardsDataStore.Data.is(storedData)) {
      return storedData;
    }

    const boardDetails = await this.loadBoardDetails(fqbn);
    if (!boardDetails) {
      return BoardsDataStore.Data.EMPTY;
    }

    const data = createDataStoreEntry(boardDetails);
    await this.storageService.setData(key, data);
    return data;
  }

  async selectProgrammer({
    fqbn,
    selectedProgrammer,
  }: {
    fqbn: string;
    selectedProgrammer: Programmer;
  }): Promise<boolean> {
    const storedData = deepClone(await this.getData(fqbn));
    const { programmers } = storedData;
    if (!programmers.find((p) => Programmer.equals(selectedProgrammer, p))) {
      return false;
    }

    const data = { ...storedData, selectedProgrammer };
    await this.setData({ fqbn, data });
    this.fireChanged({ fqbn, data });
    return true;
  }

  async selectConfigOption({
    fqbn,
    option,
    selectedValue,
  }: {
    fqbn: string;
    option: string;
    selectedValue: string;
  }): Promise<boolean> {
    const data = deepClone(await this.getData(fqbn));
    const { configOptions } = data;
    const configOption = configOptions.find((c) => c.option === option);
    if (!configOption) {
      return false;
    }
    let updated = false;
    for (const value of configOption.values) {
      const mutable: Mutable<ConfigValue> = value;
      if (mutable.value === selectedValue) {
        mutable.selected = true;
        updated = true;
      } else {
        mutable.selected = false;
      }
    }
    if (!updated) {
      return false;
    }
    await this.setData({ fqbn, data });
    this.fireChanged({ fqbn, data });
    return true;
  }

  protected async setData(change: BoardsDataStoreChange): Promise<void> {
    const { fqbn, data } = change;
    const key = this.getStorageKey(fqbn);
    return this.storageService.setData(key, data);
  }

  protected getStorageKey(fqbn: string): string {
    return `.arduinoIDE-configOptions-${fqbn}`;
  }

  async loadBoardDetails(fqbn: string): Promise<BoardDetails | undefined> {
    try {
      const details = await this.boardsService.getBoardDetails({ fqbn });
      return details;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('loading board data') &&
        err.message.includes('is not installed')
      ) {
        this.logger.warn(
          `The boards package is not installed for board with FQBN: ${fqbn}`
        );
      } else {
        this.logger.error(
          `An unexpected error occurred while retrieving the board details for ${fqbn}.`,
          err
        );
      }
      return undefined;
    }
  }

  protected fireChanged(...changes: BoardsDataStoreChange[]): void {
    this.onDidChangeEmitter.fire({ changes });
  }
}

export namespace BoardsDataStore {
  export interface Data {
    readonly configOptions: ConfigOption[];
    readonly programmers: Programmer[];
    readonly selectedProgrammer?: Programmer;
    readonly defaultProgrammerId?: string;
  }
  export namespace Data {
    export const EMPTY: Data = deepFreeze({
      configOptions: [],
      programmers: [],
    });

    export function is(arg: unknown): arg is Data {
      return (
        typeof arg === 'object' &&
        arg !== null &&
        Array.isArray((<Data>arg).configOptions) &&
        Array.isArray((<Data>arg).programmers) &&
        ((<Data>arg).selectedProgrammer === undefined ||
          isProgrammer((<Data>arg).selectedProgrammer)) &&
        ((<Data>arg).defaultProgrammerId === undefined ||
          typeof (<Data>arg).defaultProgrammerId === 'string')
      );
    }
  }
}

export function isEmptyData(data: BoardsDataStore.Data): boolean {
  return (
    Boolean(!data.configOptions.length) &&
    Boolean(!data.programmers.length) &&
    Boolean(!data.selectedProgrammer) &&
    Boolean(!data.defaultProgrammerId)
  );
}

export function findDefaultProgrammer(
  programmers: readonly Programmer[],
  defaultProgrammerId: string | undefined | BoardsDataStore.Data
): Programmer | undefined {
  if (!defaultProgrammerId) {
    return undefined;
  }
  const id =
    typeof defaultProgrammerId === 'string'
      ? defaultProgrammerId
      : defaultProgrammerId.defaultProgrammerId;
  return programmers.find((p) => p.id === id);
}
function createDataStoreEntry(details: BoardDetails): BoardsDataStore.Data {
  const configOptions = details.configOptions.slice();
  const programmers = details.programmers.slice();
  const { defaultProgrammerId } = details;
  const selectedProgrammer = findDefaultProgrammer(
    programmers,
    defaultProgrammerId
  );
  const data = {
    configOptions,
    programmers,
    ...(selectedProgrammer ? { selectedProgrammer } : {}),
    ...(defaultProgrammerId ? { defaultProgrammerId } : {}),
  };
  return data;
}

export interface BoardsDataStoreChange {
  readonly fqbn: string;
  readonly data: BoardsDataStore.Data;
}

function isBoardsDataStoreChange(arg: unknown): arg is BoardsDataStoreChange {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    typeof (<BoardsDataStoreChange>arg).fqbn === 'string' &&
    BoardsDataStore.Data.is((<BoardsDataStoreChange>arg).data)
  );
}

export interface BoardsDataStoreChangeEvent {
  readonly changes: readonly BoardsDataStoreChange[];
}

const USE_INHERITED_DATA: Command = {
  id: 'arduino-use-inherited-boards-data',
};
