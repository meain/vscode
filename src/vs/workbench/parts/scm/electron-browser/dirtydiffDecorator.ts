/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/dirtydiffDecorator';
import { ThrottledDelayer, always } from 'vs/base/common/async';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import * as winjs from 'vs/base/common/winjs.base';
import * as ext from 'vs/workbench/common/contributions';
import * as common from 'vs/editor/common/editorCommon';
import * as widget from 'vs/editor/browser/codeEditor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IMessageService } from 'vs/platform/message/common/message';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ITextModelResolverService } from 'vs/editor/common/services/resolverService';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IEditorWorkerService } from 'vs/editor/common/services/editorWorkerService';
import URI from 'vs/base/common/uri';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { ISCMService } from 'vs/workbench/services/scm/common/scm';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModelWithDecorations';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { registerThemingParticipant, ITheme, ICssStyleCollector } from 'vs/platform/theme/common/themeService';
import { registerColor } from 'vs/platform/theme/common/colorRegistry';
import { localize } from 'vs/nls';
import { Color } from 'vs/base/common/color';

class DirtyDiffModelDecorator {

	static MODIFIED_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-modified-glyph',
		isWholeLine: true,
		overviewRuler: {
			color: 'rgba(0, 122, 204, 0.6)',
			darkColor: 'rgba(0, 122, 204, 0.6)',
			position: common.OverviewRulerLane.Left
		}
	});

	static ADDED_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-added-glyph',
		isWholeLine: true,
		overviewRuler: {
			color: 'rgba(0, 122, 204, 0.6)',
			darkColor: 'rgba(0, 122, 204, 0.6)',
			position: common.OverviewRulerLane.Left
		}
	});

	static DELETED_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-deleted-glyph',
		isWholeLine: true,
		overviewRuler: {
			color: 'rgba(0, 122, 204, 0.6)',
			darkColor: 'rgba(0, 122, 204, 0.6)',
			position: common.OverviewRulerLane.Left
		}
	});

	static HIDDEN_DECORATION_OPTIONS = ModelDecorationOptions.register({
		linesDecorationsClassName: 'dirty-diff-hidden-glyph',
		isWholeLine: true,
		overviewRuler: {
			color: 'rgba(0, 0, 0, 0)',
			darkColor: 'rgba(0, 0, 0, 0)',
			position: common.OverviewRulerLane.Left
		}
	});

	private configurationService: IConfigurationService;
	private decorations: string[];
	private baselineModel: common.IModel;
	private diffDelayer: ThrottledDelayer<common.IChange[]>;
	private _originalURIPromise: winjs.TPromise<URI>;
	private toDispose: IDisposable[];

	constructor(
		private model: common.IModel,
		private uri: URI,
		@ISCMService private scmService: ISCMService,
		@IModelService private modelService: IModelService,
		@IEditorWorkerService private editorWorkerService: IEditorWorkerService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@ITextModelResolverService private textModelResolverService: ITextModelResolverService,
		@IConfigurationService configurationService: IConfigurationService
	) {
		this.decorations = [];
		this.diffDelayer = new ThrottledDelayer<common.IChange[]>(200);
		this.toDispose = [];
		this.triggerDiff();
		this.toDispose.push(model.onDidChangeContent(() => this.triggerDiff()));
		this.toDispose.push(scmService.onDidChangeProvider(() => this.triggerDiff()));
		this.configurationService = configurationService;
	}

	private triggerDiff(): winjs.Promise {
		if (!this.diffDelayer) {
			return winjs.TPromise.as(null);
		}

		return this.diffDelayer
			.trigger(() => this.diff())
			.then((diff: common.IChange[]) => {
				if (!this.model || this.model.isDisposed() || !this.baselineModel || this.baselineModel.isDisposed()) {
					return undefined; // disposed
				}

				if (this.baselineModel.getValueLength() === 0) {
					diff = [];
				}

				// check whether decorations should be hidden
				const hiddenDecorations = !this.configurationService.getConfiguration<IEditorOptions>('editor').showChangesInGutter;

				return this.decorations = this.model.deltaDecorations(this.decorations, DirtyDiffModelDecorator.changesToDecorations(diff || [], hiddenDecorations));
			});
	}

	private diff(): winjs.TPromise<common.IChange[]> {
		return this.getOriginalURIPromise().then(originalURI => {
			if (!this.model || this.model.isDisposed() || !originalURI) {
				return winjs.TPromise.as([]); // disposed
			}

			return this.editorWorkerService.computeDirtyDiff(originalURI, this.model.uri, true);
		});
	}

	private getOriginalURIPromise(): winjs.TPromise<URI> {
		if (this._originalURIPromise) {
			return this._originalURIPromise;
		}

		const provider = this.scmService.activeProvider;

		if (!provider) {
			return winjs.TPromise.as(null);
		}

		this._originalURIPromise = provider.getOriginalResource(this.uri)
			.then(originalUri => {
				if (!originalUri) {
					return null;
				}

				return this.textModelResolverService.createModelReference(originalUri)
					.then(ref => {
						this.baselineModel = ref.object.textEditorModel;

						this.toDispose.push(ref);
						this.toDispose.push(ref.object.textEditorModel.onDidChangeContent(() => this.triggerDiff()));

						return originalUri;
					});
			});

		return always(this._originalURIPromise, () => {
			this._originalURIPromise = null;
		});
	}

	private static changesToDecorations(diff: common.IChange[], hidden = false): common.IModelDeltaDecoration[] {
		return diff.map((change) => {
			if (hidden) {
				return {
					range: {
						startLineNumber: 0, startColumn: 1,
						endLineNumber: 0, endColumn: 0
					},
					options: DirtyDiffModelDecorator.HIDDEN_DECORATION_OPTIONS
				};
			}

			const startLineNumber = change.modifiedStartLineNumber;
			const endLineNumber = change.modifiedEndLineNumber || startLineNumber;

			// Added
			if (change.originalEndLineNumber === 0) {
				return {
					range: {
						startLineNumber: startLineNumber, startColumn: 1,
						endLineNumber: endLineNumber, endColumn: 1
					},
					options: DirtyDiffModelDecorator.ADDED_DECORATION_OPTIONS
				};
			}

			// Removed
			if (change.modifiedEndLineNumber === 0) {
				return {
					range: {
						startLineNumber: startLineNumber, startColumn: 1,
						endLineNumber: startLineNumber, endColumn: 1
					},
					options: DirtyDiffModelDecorator.DELETED_DECORATION_OPTIONS
				};
			}

			// Modified
			return {
				range: {
					startLineNumber: startLineNumber, startColumn: 1,
					endLineNumber: endLineNumber, endColumn: 1
				},
				options: DirtyDiffModelDecorator.MODIFIED_DECORATION_OPTIONS
			};
		});
	}

	dispose(): void {
		this.toDispose = dispose(this.toDispose);

		if (this.model && !this.model.isDisposed()) {
			this.model.deltaDecorations(this.decorations, []);
		}

		this.model = null;
		this.baselineModel = null;
		this.decorations = null;

		if (this.diffDelayer) {
			this.diffDelayer.cancel();
			this.diffDelayer = null;
		}
	}
}

export class DirtyDiffDecorator implements ext.IWorkbenchContribution {

	private models: common.IModel[] = [];
	private decorators: { [modelId: string]: DirtyDiffModelDecorator } = Object.create(null);
	private toDispose: IDisposable[] = [];

	constructor(
		@IMessageService private messageService: IMessageService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IEditorGroupService editorGroupService: IEditorGroupService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		this.toDispose.push(editorGroupService.onEditorsChanged(() => this.onEditorsChanged()));
	}

	getId(): string {
		return 'git.DirtyDiffModelDecorator';
	}

	private onEditorsChanged(): void {
		// HACK: This is the best current way of figuring out whether to draw these decorations
		// or not. Needs context from the editor, to know whether it is a diff editor, in place editor
		// etc.

		const models = this.editorService.getVisibleEditors()

			// map to the editor controls
			.map(e => e.getControl())

			// only interested in code editor widgets
			.filter(c => c instanceof widget.CodeEditor)

			// map to models
			.map(e => (<widget.CodeEditor>e).getModel())

			// remove nulls and duplicates
			.filter((m, i, a) => !!m && !!m.uri && a.indexOf(m, i + 1) === -1)

			// get the associated resource
			.map(m => ({ model: m, uri: m.uri }));

		const newModels = models.filter(p => this.models.every(m => p.model !== m));
		const oldModels = this.models.filter(m => models.every(p => p.model !== m));

		newModels.forEach(({ model, uri }) => this.onModelVisible(model, uri));
		oldModels.forEach(m => this.onModelInvisible(m));

		this.models = models.map(p => p.model);
	}

	private onModelVisible(model: common.IModel, uri: URI): void {
		this.decorators[model.id] = this.instantiationService.createInstance(DirtyDiffModelDecorator, model, uri);
	}

	private onModelInvisible(model: common.IModel): void {
		this.decorators[model.id].dispose();
		delete this.decorators[model.id];
	}

	dispose(): void {
		this.toDispose = dispose(this.toDispose);
		this.models.forEach(m => this.decorators[m.id].dispose());
		this.models = null;
		this.decorators = null;
	}
}

export const editorGutterModifiedBackground = registerColor('editorGutter.modifiedBackground', {
	dark: Color.fromHex('#00bcf2').transparent(0.6),
	light: Color.fromHex('#007acc').transparent(0.6),
	hc: Color.fromHex('#007acc').transparent(0.6)
}, localize('editorGutterModifiedBackground', "Editor gutter background color for lines that are modified."));

export const editorGutterAddedBackground = registerColor('editorGutter.addedBackground', {
	dark: Color.fromHex('#7fba00').transparent(0.6),
	light: Color.fromHex('#2d883e').transparent(0.6),
	hc: Color.fromHex('#2d883e').transparent(0.6)
}, localize('editorGutterAddedBackground', "Editor gutter background color for lines that are added."));

export const editorGutterDeletedBackground = registerColor('editorGutter.deletedBackground', {
	dark: Color.fromHex('#b9131a').transparent(0.76),
	light: Color.fromHex('#b9131a').transparent(0.76),
	hc: Color.fromHex('#b9131a').transparent(0.76)
}, localize('editorGutterDeletedBackground', "Editor gutter background color for lines that are deleted."));

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {
	const editorGutterModifiedBackgroundColor = theme.getColor(editorGutterModifiedBackground);
	if (editorGutterModifiedBackgroundColor) {
		collector.addRule(`.monaco-editor .dirty-diff-modified-glyph { border-left: 3px solid ${editorGutterModifiedBackgroundColor}; }`);
	}

	const editorGutterAddedBackgroundColor = theme.getColor(editorGutterAddedBackground);
	if (editorGutterAddedBackgroundColor) {
		collector.addRule(`.monaco-editor .dirty-diff-added-glyph { border-left: 3px solid ${editorGutterAddedBackgroundColor}; }`);
	}

	const editorGutterDeletedBackgroundColor = theme.getColor(editorGutterDeletedBackground);
	if (editorGutterDeletedBackgroundColor) {
		collector.addRule(`
			.monaco-editor .dirty-diff-deleted-glyph:after {
				border-top: 4px solid transparent;
				border-bottom: 4px solid transparent;
				border-left: 4px solid ${editorGutterDeletedBackgroundColor};
			}
		`);
	}

	// TODO: Cleanup
	collector.addRule(`
			.monaco-editor .dirty-diff-hidden-glyph {
				display: none;
			}
	`);
});