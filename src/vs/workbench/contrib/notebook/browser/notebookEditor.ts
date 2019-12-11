/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./notebook';
import * as DOM from 'vs/base/browser/dom';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { NotebookEditorInput, ICell, NotebookEditorModel } from 'vs/workbench/contrib/notebook/browser/notebookEditorInput';
import { EditorOptions } from 'vs/workbench/common/editor';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from 'vs/editor/browser/widget/codeEditorWidget';
import * as marked from 'vs/base/common/marked/marked';
import { IModelService } from 'vs/editor/common/services/modelService';
import { URI } from 'vs/base/common/uri';
import { deepClone } from 'vs/base/common/objects';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { getExtraColor } from 'vs/workbench/contrib/welcome/walkThrough/common/walkThroughUtils';
import { textLinkForeground, textLinkActiveForeground, focusBorder, textPreformatForeground, contrastBorder, textBlockQuoteBackground, textBlockQuoteBorder, editorBackground, foreground } from 'vs/platform/theme/common/colorRegistry';
import { IListRenderer, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { WorkbenchList } from 'vs/platform/list/browser/listService';
import { BareFontInfo } from 'vs/editor/common/config/fontInfo';
import { getZoomLevel } from 'vs/base/browser/browser';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Action } from 'vs/base/common/actions';
import { IDisposable } from 'vs/base/common/lifecycle';
import { IEditorContributionDescription } from 'vs/editor/browser/editorExtensions';
import { MenuPreventer } from 'vs/workbench/contrib/codeEditor/browser/menuPreventer';
import { SuggestController } from 'vs/editor/contrib/suggest/suggestController';
import { SnippetController2 } from 'vs/editor/contrib/snippet/snippetController2';
import { TabCompletionController } from 'vs/workbench/contrib/snippets/browser/tabCompletion';
import { MimeTypeRenderer } from 'vs/workbench/contrib/notebook/browser/output';
import { ElementSizeObserver } from 'vs/editor/browser/config/elementSizeObserver';
import { ITextModel } from 'vs/editor/common/model';
import { IModeService } from 'vs/editor/common/services/modeService';

const $ = DOM.$;

class ViewCell {
	private _textModel: ITextModel | null = null;
	private _mdRenderer: marked.Renderer | null = null;
	private _html: string | null = null;
	private _dynamicHeight: number | null = null;

	get cellType() {
		return this.cell.cell_type;
	}

	get lineCount() {
		return this.cell.source.length;
	}

	get outputs() {
		return this.cell.outputs;
	}

	constructor(
		public cell: ICell,
		public isEditing: boolean,
		private readonly modelService: IModelService,
		private readonly modeService: IModeService
	) {

	}

	hasDynamicHeight() {
		if (this._dynamicHeight !== null) {
			return false;
		}

		return true;
	}

	setDynamicHeight(height: number) {
		this._dynamicHeight = height;
	}

	getHeight(lineHeight: number) {
		if (this._dynamicHeight) {
			return this._dynamicHeight;
		}

		if (this.cellType === 'markdown') {
			return 100;
		} else {
			return Math.max(this.lineCount + 1, 5) * lineHeight + 16;
		}
	}

	setText(strs: string[]) {
		this.cell.source = strs.map(str => str + '\n');
		this._html = null;
	}

	save() {
		if (this._textModel && this.isEditing) {
			this.cell.source = this._textModel.getLinesContent().map(str => str + '\n');
		}
	}

	getText(): string {
		return this.cell.source.join('');
	}

	getHTML(): string | null {
		if (this.cellType === 'markdown') {
			if (this._html) {
				return this._html;
			}

			let renderer = this.getMDRenderer();
			this._html = marked(this.getText(), { renderer: renderer });
			return this._html;
		}

		return null;
	}

	getTextModel(): ITextModel {
		if (!this._textModel) {
			let ext = this.cellType === 'markdown' ? 'md' : 'py';
			const resource = URI.parse(`notebookcell-${Date.now()}.${ext}`);
			let content = this.cell.source.join('');
			this._textModel = this.modelService.createModel(content, this.modeService.createByFilepathOrFirstLine(resource), resource, false);
		}

		return this._textModel;
	}

	private getMDRenderer() {

		if (!this._mdRenderer) {
			this._mdRenderer = new marked.Renderer();
		}

		return this._mdRenderer;

	}
}

interface NotebookHandler {
	insertEmptyNotebookCell(cell: ViewCell, type: 'markdown' | 'code', direction: 'above' | 'below'): void;
	deleteNotebookCell(cell: ViewCell): void;
	layoutElement(cell: ViewCell, height: number): void;
}

interface CellRenderTemplate {
	container: HTMLElement;
	cellContainer: HTMLElement;
	menuContainer?: HTMLElement;
	editingContainer?: HTMLElement;
	outputContainer?: HTMLElement;
	editor?: CodeEditorWidget;
	model?: ITextModel;
}

export class NotebookCellListDelegate implements IListVirtualDelegate<ViewCell> {
	private _lineHeight: number;
	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		const editorOptions = this.configurationService.getValue<IEditorOptions>('editor');
		this._lineHeight = BareFontInfo.createFromRawSettings(editorOptions, getZoomLevel()).lineHeight;
	}

	getHeight(element: ViewCell): number {
		return element.getHeight(this._lineHeight);
	}

	hasDynamicHeight(element: ViewCell): boolean {
		return element.hasDynamicHeight();
	}

	getTemplateId(element: ViewCell): string {
		if (element.cellType === 'markdown') {
			return MarkdownCellRenderer.TEMPLATE_ID;
		} else {
			return CodeCellRenderer.TEMPLATE_ID;
		}
	}
}

class AbstractCellRenderer {
	constructor(
		protected handler: NotebookHandler,
		private contextMenuService: IContextMenuService
	) { }

	showContextMenu(element: ViewCell, x: number, y: number) {
		const actions: Action[] = [];
		const insertAbove = new Action(
			'workbench.notebook.code.insertCellAbove',
			'Insert Code Cell Above',
			undefined,
			true,
			async () => {
				this.handler.insertEmptyNotebookCell(element, 'code', 'above');
			}
		);

		const insertBelow = new Action(
			'workbench.notebook.code.insertCellBelow',
			'Insert Code Cell Below',
			undefined,
			true,
			async () => {
				this.handler.insertEmptyNotebookCell(element, 'code', 'below');
			}
		);

		const insertMarkdownAbove = new Action(
			'workbench.notebook.markdown.insertCellAbove',
			'Insert Markdown Cell Above',
			undefined,
			true,
			async () => {
				this.handler.insertEmptyNotebookCell(element, 'markdown', 'above');
			}
		);

		const insertMarkdownBelow = new Action(
			'workbench.notebook.markdown.insertCellBelow',
			'Insert Markdown Cell Below',
			undefined,
			true,
			async () => {
				this.handler.insertEmptyNotebookCell(element, 'markdown', 'below');
			}
		);

		const deleteCell = new Action(
			'workbench.notebook.deleteCell',
			'Delete Cell',
			undefined,
			true,
			async () => {
				this.handler.deleteNotebookCell(element);
			}
		);

		actions.push(insertMarkdownAbove);
		actions.push(insertMarkdownBelow);
		actions.push(insertAbove);
		actions.push(insertBelow);
		actions.push(deleteCell);

		this.contextMenuService.showContextMenu({
			getAnchor: () => {
				return {
					x,
					y
				};
			},
			getActions: () => {
				return actions;
			},
			autoSelectFirstItem: true
		});
	}
}

export class MarkdownCellRenderer extends AbstractCellRenderer implements IListRenderer<ViewCell, CellRenderTemplate> {
	static readonly TEMPLATE_ID = 'markdown_cell';
	private disposables: Map<HTMLElement, IDisposable> = new Map();
	private editorOptions: IEditorOptions;

	constructor(
		handler: NotebookHandler,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService contextMenuService: IContextMenuService
	) {
		super(handler, contextMenuService);
		const language = 'python';
		const editorOptions = deepClone(this.configurationService.getValue<IEditorOptions>('editor', { overrideIdentifier: language }));
		this.editorOptions = {
			...editorOptions,
			scrollBeyondLastLine: false,
			scrollbar: {
				verticalScrollbarSize: 14,
				horizontal: 'auto',
				useShadows: true,
				verticalHasArrows: false,
				horizontalHasArrows: false
			},
			overviewRulerLanes: 3,
			fixedOverflowWidgets: false,
			lineNumbersMinChars: 1,
			minimap: { enabled: false },
		};
	}

	get templateId() {
		return MarkdownCellRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): CellRenderTemplate {
		const codeInnerContent = document.createElement('div');
		DOM.addClasses(codeInnerContent, 'cell', 'code');
		codeInnerContent.style.display = 'none';

		container.appendChild(codeInnerContent);

		const innerContent = document.createElement('div');
		DOM.addClasses(innerContent, 'cell', 'markdown');
		container.appendChild(innerContent);

		const action = document.createElement('div');
		DOM.addClasses(action, 'menu', 'codicon-settings-gear', 'codicon');
		container.appendChild(action);

		return {
			container: container,
			cellContainer: innerContent,
			menuContainer: action,
			editingContainer: codeInnerContent
		};
	}

	renderElement(element: ViewCell, index: number, templateData: CellRenderTemplate, height: number | undefined): void {
		if (element.isEditing) {
			templateData.editingContainer!.style.display = 'block';
			const width = templateData.container.clientWidth;
			const lineNum = element.lineCount;
			const totalHeight = Math.max(lineNum + 1, 5) * 21;

			templateData.editingContainer!.innerHTML = '';
			const editor = this.instantiationService.createInstance(CodeEditorWidget, templateData.editingContainer!, {
				...this.editorOptions,
				dimension: {
					width: width,
					height: totalHeight
				}
			}, {});
			const model = element.getTextModel();
			editor.setModel(model);
			templateData.cellContainer.innerHTML = element.getHTML() || '';

			if (height) {
				model.onDidChangeContent(e => {
					element.setText(model.getLinesContent());
					templateData.cellContainer.innerHTML = element.getHTML() || '';

					const clientHeight = templateData.cellContainer.clientHeight;
					this.handler.layoutElement(element, totalHeight + 32 + clientHeight);
				});
			}
		} else {
			templateData.editingContainer!.style.display = 'none';
			templateData.editingContainer!.innerHTML = '';
			templateData.cellContainer.innerHTML = element.getHTML() || '';
		}

		let disposable = this.disposables.get(templateData.menuContainer!);

		if (disposable) {
			disposable.dispose();
			this.disposables.delete(templateData.menuContainer!);
		}

		let listener = DOM.addStandardDisposableListener(templateData.menuContainer!, 'mousedown', e => {
			const { top, height } = DOM.getDomNodePagePosition(templateData.menuContainer!);
			e.preventDefault();

			this.showContextMenu(element, e.posx, top + height);
		});

		this.disposables.set(templateData.menuContainer!, listener);
	}

	disposeTemplate(templateData: CellRenderTemplate): void {
		// throw nerendererw Error('Method not implemented.');
	}
}

export class CodeCellRenderer extends AbstractCellRenderer implements IListRenderer<ViewCell, CellRenderTemplate> {
	static readonly TEMPLATE_ID = 'code_cell';
	private editorOptions: IEditorOptions;
	private disposables: Map<HTMLElement, IDisposable> = new Map();

	constructor(
		handler: NotebookHandler,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService
	) {
		super(handler, contextMenuService);

		const language = 'python';
		const editorOptions = deepClone(this.configurationService.getValue<IEditorOptions>('editor', { overrideIdentifier: language }));
		this.editorOptions = {
			...editorOptions,
			scrollBeyondLastLine: false,
			scrollbar: {
				verticalScrollbarSize: 14,
				horizontal: 'auto',
				useShadows: true,
				verticalHasArrows: false,
				horizontalHasArrows: false
			},
			overviewRulerLanes: 3,
			fixedOverflowWidgets: false,
			lineNumbersMinChars: 1,
			minimap: { enabled: false },
		};
	}

	get templateId() {
		return CodeCellRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): CellRenderTemplate {
		const innerContent = document.createElement('div');
		DOM.addClasses(innerContent, 'cell', 'code');
		container.appendChild(innerContent);
		const editor = this.instantiationService.createInstance(CodeEditorWidget, innerContent, {
			...this.editorOptions,
			dimension: {
				width: 0,
				height: 0
			}
		}, {});
		const action = document.createElement('div');
		DOM.addClasses(action, 'menu', 'codicon-settings-gear', 'codicon');
		container.appendChild(action);

		const outputContainer = document.createElement('div');
		DOM.addClasses(outputContainer, 'output');
		container.appendChild(outputContainer);

		return {
			container: container,
			cellContainer: innerContent,
			menuContainer: action,
			outputContainer: outputContainer,
			editor
		};
	}

	renderElement(element: ViewCell, index: number, templateData: CellRenderTemplate, height: number | undefined): void {
		const innerContent = templateData.cellContainer;
		const width = innerContent.clientWidth;
		const lineNum = element.lineCount;
		const totalHeight = Math.max(lineNum + 1, 5) * 21;
		const model = element.getTextModel();
		templateData.editor?.setModel(model);
		templateData.editor?.layout(
			{
				width: width,
				height: totalHeight
			}
		);

		let listener = DOM.addStandardDisposableListener(templateData.menuContainer!, 'mousedown', e => {
			const { top, height } = DOM.getDomNodePagePosition(templateData.menuContainer!);
			e.preventDefault();

			this.showContextMenu(element, e.posx, top + height);
		});

		this.disposables.set(templateData.cellContainer, listener);

		if (templateData.outputContainer) {
			templateData.outputContainer!.innerHTML = '';
		}

		if (element.outputs.length > 0) {
			let hasDynamicHeight = false;
			for (let i = 0; i < element.outputs.length; i++) {
				let result = MimeTypeRenderer.render(element.outputs[i], this.themeService);
				if (result) {
					hasDynamicHeight = result?.hasDynamicHeight;
					templateData.outputContainer?.appendChild(result.element);
				}
			}

			if (element.hasDynamicHeight() && height !== undefined) {
				let dimensions = DOM.getClientArea(templateData.outputContainer!);
				const elementSizeObserver = new ElementSizeObserver(templateData.outputContainer!, dimensions, () => {
					if (templateData.outputContainer && document.body.contains(templateData.outputContainer!)) {
						let height = elementSizeObserver.getHeight();
						if (dimensions.height !== height) {
							element.setDynamicHeight(totalHeight + 32 + height);
							this.handler.layoutElement(element, totalHeight + 32 + height);
						}
					}
				});
				elementSizeObserver.startObserving();
				if (!hasDynamicHeight && dimensions.height !== 0) {
					element.setDynamicHeight(totalHeight + 32 + dimensions.height);
					this.handler.layoutElement(element, totalHeight + 32 + dimensions.height);
				}

				this.disposables.set(templateData.outputContainer!, {
					dispose: () => {
						elementSizeObserver.stopObserving();
						elementSizeObserver.dispose();
					}
				});
			}
		}

	}

	disposeTemplate(templateData: CellRenderTemplate): void {
		// throw nerendererw Error('Method not implemented.');
	}


	disposeElement(element: ViewCell, index: number, templateData: CellRenderTemplate, height: number | undefined): void {
		let cellDisposable = this.disposables.get(templateData.cellContainer);

		if (cellDisposable) {
			cellDisposable.dispose();
			this.disposables.delete(templateData.cellContainer);
		}

		if (templateData.outputContainer) {
			let outputDisposable = this.disposables.get(templateData.outputContainer!);

			if (outputDisposable) {
				outputDisposable.dispose();
				this.disposables.delete(templateData.outputContainer!);
			}
		}
	}

	getSimpleCodeEditorWidgetOptions(): ICodeEditorWidgetOptions {
		return {
			isSimpleWidget: false,
			contributions: <IEditorContributionDescription[]>[
				{ id: MenuPreventer.ID, ctor: MenuPreventer },
				{ id: SuggestController.ID, ctor: SuggestController },
				// { id: ModesHoverController.ID, ctor: ModesHoverController },
				{ id: SnippetController2.ID, ctor: SnippetController2 },
				{ id: TabCompletionController.ID, ctor: TabCompletionController },
			]
		};
	}
}


export class NotebookEditor extends BaseEditor implements NotebookHandler {
	static readonly ID: string = 'workbench.editor.notebook';
	private rootElement!: HTMLElement;
	private body!: HTMLElement;
	private list: WorkbenchList<ViewCell> | undefined;
	private model: NotebookEditorModel | undefined;
	private viewCells: ViewCell[] = [];

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@IModeService private readonly modeService: IModeService,
		@IStorageService storageService: IStorageService
	) {
		super(NotebookEditor.ID, telemetryService, themeService, storageService);
	}

	get minimumWidth(): number { return 375; }
	get maximumWidth(): number { return Number.POSITIVE_INFINITY; }

	// these setters need to exist because this extends from BaseEditor
	set minimumWidth(value: number) { /*noop*/ }
	set maximumWidth(value: number) { /*noop*/ }


	protected createEditor(parent: HTMLElement): void {
		this.rootElement = DOM.append(parent, $('.notebook-editor'));
		this.createBody(this.rootElement);
	}

	private createBody(parent: HTMLElement): void {
		this.body = document.createElement('div');
		DOM.addClass(this.body, 'cell-list-container');
		this.createCellList();
		DOM.append(parent, this.body);
	}

	private createCellList(): void {
		DOM.addClass(this.body, 'cell-list-container');

		const renders = [
			this.instantiationService.createInstance(MarkdownCellRenderer, this),
			this.instantiationService.createInstance(CodeCellRenderer, this)
		];

		this.list = this.instantiationService.createInstance<typeof WorkbenchList, WorkbenchList<ViewCell>>(
			WorkbenchList,
			'NotebookCellList',
			this.body,
			this.instantiationService.createInstance(NotebookCellListDelegate),
			renders,
			{
				setRowLineHeight: false,
				supportDynamicHeights: true,
				horizontalScrolling: false,
				keyboardSupport: false,
				mouseSupport: false,
				multipleSelectionSupport: false,
				overrideStyles: {
					listBackground: editorBackground,
					listActiveSelectionBackground: editorBackground,
					listActiveSelectionForeground: foreground,
					listFocusAndSelectionBackground: editorBackground,
					listFocusAndSelectionForeground: foreground,
					listFocusBackground: editorBackground,
					listFocusForeground: foreground,
					listHoverForeground: foreground,
					listHoverBackground: editorBackground,
					listHoverOutline: focusBorder,
					listFocusOutline: focusBorder,
					listInactiveSelectionBackground: editorBackground,
					listInactiveSelectionForeground: foreground,
					listInactiveFocusBackground: editorBackground,
					listInactiveFocusOutline: editorBackground,
				}
			}
		);
	}

	onHide() {
		super.onHide();

		this.viewCells.forEach(cell => cell.isEditing = false);
	}

	setInput(input: NotebookEditorInput, options: EditorOptions | undefined, token: CancellationToken): Promise<void> {
		return super.setInput(input, options, token)
			.then(() => {
				return input.resolve();
			})
			.then(model => {
				if (this.model !== undefined && this.model.textModel === model.textModel) {
					return;
				}

				this.viewCells.forEach(cell => {
					cell.save();
				});

				this.model = model;
				this.viewCells = model.getNotebook().cells.map(cell => {
					return new ViewCell(cell, false, this.modelService, this.modeService);
				});
				this.list?.splice(0, this.list?.length, this.viewCells);
				this.list?.layout();
			});
	}

	layoutElement(cell: ViewCell, height: number) {
		setTimeout(() => {
			// list.splice -> renderElement -> resize -> layoutElement
			// above flow will actually break how list view renders it self as it messes up with the internal state
			// instead we run the layout update in next tick
			let index = this.model!.getNotebook().cells.indexOf(cell.cell);
			this.list?.updateDynamicHeight(index, cell, height);
		}, 0);
	}

	insertEmptyNotebookCell(cell: ViewCell, type: 'code' | 'markdown', direction: 'above' | 'below') {
		let newCell = new ViewCell({
			cell_type: type,
			source: [],
			outputs: []
		}, type === 'markdown', this.modelService, this.modeService);

		let index = this.model!.getNotebook().cells.indexOf(cell.cell);
		const insertIndex = direction === 'above' ? index : index + 1;

		this.viewCells!.splice(insertIndex, 0, newCell);
		this.model!.insertCell(newCell.cell, insertIndex);
		this.list?.splice(insertIndex, 0, [newCell]);
	}

	deleteNotebookCell(cell: ViewCell) {
		let index = this.model!.getNotebook().cells.indexOf(cell.cell);

		this.viewCells!.splice(index, 1);
		this.model!.deleteCell(cell.cell);
		this.list?.splice(index, 1);
	}


	layout(dimension: DOM.Dimension): void {
		DOM.toggleClass(this.rootElement, 'mid-width', dimension.width < 1000 && dimension.width >= 600);
		DOM.toggleClass(this.rootElement, 'narrow-width', dimension.width < 600);
		DOM.size(this.body, dimension.width - 40, dimension.height);
		this.list?.layout(dimension.height, dimension.width - 40);
	}
}

const embeddedEditorBackground = 'walkThrough.embeddedEditorBackground';

registerThemingParticipant((theme, collector) => {
	const color = getExtraColor(theme, embeddedEditorBackground, { dark: 'rgba(0, 0, 0, .4)', extra_dark: 'rgba(200, 235, 255, .064)', light: '#f4f4f4', hc: null });
	if (color) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor .monaco-editor-background,
			.monaco-workbench .part.editor > .content .notebook-editor .margin-view-overlays { background: ${color}; }`);
	}
	const link = theme.getColor(textLinkForeground);
	if (link) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor a { color: ${link}; }`);
	}
	const activeLink = theme.getColor(textLinkActiveForeground);
	if (activeLink) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor a:hover,
			.monaco-workbench .part.editor > .content .notebook-editor a:active { color: ${activeLink}; }`);
	}
	const focusColor = theme.getColor(focusBorder);
	if (focusColor) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor a:focus { outline-color: ${focusColor}; }`);
	}
	const shortcut = theme.getColor(textPreformatForeground);
	if (shortcut) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor code,
			.monaco-workbench .part.editor > .content .notebook-editor .shortcut { color: ${shortcut}; }`);
	}
	const border = theme.getColor(contrastBorder);
	if (border) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor .monaco-editor { border-color: ${border}; }`);
	}
	const quoteBackground = theme.getColor(textBlockQuoteBackground);
	if (quoteBackground) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor blockquote { background: ${quoteBackground}; }`);
	}
	const quoteBorder = theme.getColor(textBlockQuoteBorder);
	if (quoteBorder) {
		collector.addRule(`.monaco-workbench .part.editor > .content .notebook-editor blockquote { border-color: ${quoteBorder}; }`);
	}
});
