import { enableJSDOM } from '@theia/core/lib/browser/test/jsdom';
const disableJSDOM = enableJSDOM();

import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
FrontendApplicationConfigProvider.set({});

import { deepClone } from '@theia/core/lib/common/objects';
import { Mutable } from '@theia/core/lib/common/types';
import { expect } from 'chai';
import { doesNotReject, rejects } from 'node:assert/strict';
import { BoardsDataStore } from '../../browser/boards/boards-data-store';
import {
  debuggingNotSupported,
  isDebugEnabled,
  noPlatformInstalledFor,
  noProgrammerSelectedFor,
  sketchIsNotCompiled,
} from '../../browser/contributions/debug';
import { noBoardSelected, noSketchOpened } from '../../common/nls';
import type { BoardDetails, Programmer, Sketch } from '../../common/protocol';

disableJSDOM();

describe('debug', () => {
  describe('isDebugEnabled', () => {
    const fqbn = 'a:b:c';
    const name = 'ABC';
    const board = { fqbn, name };
    const sketch: Sketch = {
      name: 'My_Sketch',
      uri: 'file:///path/to/mySketch/',
      mainFileUri: 'file:///path/to/mySketch/mySketch.in',
      additionalFileUris: [],
      otherSketchFileUris: [],
      rootFolderFileUris: [],
    };
    const p1: Programmer = { id: 'p1', name: 'P1', platform: 'The platform' };
    const p2: Programmer = { id: 'p2', name: 'P2', platform: 'The platform' };
    const data: BoardsDataStore.Data = {
      configOptions: [],
      defaultProgrammerId: 'p1',
      programmers: [p1, p2],
      selectedProgrammer: p1,
    };
    const boardDetails: BoardDetails = {
      buildProperties: [],
      configOptions: [],
      defaultProgrammerId: 'p1',
      programmers: [p1, p2],
      fqbn,
      PID: '0',
      VID: '0',
      requiredTools: [],
    };

    it('should error when the sketch is not opened', async () => {
      await rejects(
        isDebugEnabled(
          undefined,
          board,
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall()
        ),
        (reason) => reason instanceof Error && reason.message === noSketchOpened
      );
    });

    it('should error when not a valid sketch', async () => {
      await rejects(
        isDebugEnabled(
          'invalid',
          board,
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall()
        ),
        (reason) => reason instanceof Error && reason.message === noSketchOpened
      );
    });

    it('should error when no board selected', async () => {
      await rejects(
        isDebugEnabled(
          sketch,
          undefined,
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall()
        ),
        (reason) =>
          reason instanceof Error && reason.message === noBoardSelected
      );
    });

    it('should error when platform is not installed (FQBN is undefined)', async () => {
      await rejects(
        isDebugEnabled(
          sketch,
          { name, fqbn: undefined },
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall(),
          unexpectedCall()
        ),
        (reason) =>
          reason instanceof Error &&
          reason.message === noPlatformInstalledFor(board.name)
      );
    });

    it('should error when platform is not installed (board details not available)', async () => {
      await rejects(
        isDebugEnabled(
          sketch,
          board,
          () => undefined,
          () => data,
          (fqbn) => fqbn,
          unexpectedCall(),
          unexpectedCall()
        ),
        (reason) =>
          reason instanceof Error &&
          reason.message === noPlatformInstalledFor(board.name)
      );
    });

    it('should error when no programmer selected', async () => {
      const copyData: Mutable<BoardsDataStore.Data> = deepClone(data);
      delete copyData.selectedProgrammer;
      await rejects(
        isDebugEnabled(
          sketch,
          board,
          () => boardDetails,
          () => copyData,
          (fqbn) => fqbn,
          unexpectedCall(),
          unexpectedCall()
        ),
        (reason) =>
          reason instanceof Error &&
          reason.message === noProgrammerSelectedFor(board.name)
      );
    });

    it('should error when the sketch is not verified', async () => {
      const err = Object.assign(new Error('sketch is not verifier'), {
        myCode: 'x',
      });
      await rejects(
        isDebugEnabled(
          sketch,
          board,
          () => boardDetails,
          () => data,
          (fqbn) => fqbn,
          () => {
            throw err;
          },
          (reason) =>
            reason instanceof Error &&
            'myCode' in reason &&
            reason['myCode'] === 'x'
        ),
        (reason) =>
          reason instanceof Error &&
          reason.message === sketchIsNotCompiled(sketch.name)
      );
    });

    it('should error when it fails to get the debug info from the CLI', async () => {
      await rejects(
        isDebugEnabled(
          sketch,
          board,
          () => boardDetails,
          () => data,
          (fqbn) => fqbn,
          () => {
            throw new Error('unhandled error');
          },
          () => false
        ),
        (reason) =>
          reason instanceof Error &&
          reason.message === debuggingNotSupported(board.name)
      );
    });

    it('should resolve when debugging is supported', async () => {
      await doesNotReject(
        isDebugEnabled(
          sketch,
          board,
          () => boardDetails,
          () => data,
          (fqbn) => fqbn,
          () => Promise.resolve(),
          unexpectedCall()
        )
      );
    });

    function unexpectedCall(): () => never {
      return () => expect.fail('unexpected call');
    }
  });
});
