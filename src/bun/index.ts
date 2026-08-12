import { BrowserView, BrowserWindow, type RPCSchema } from "electrobun/bun";
import { createStore, openKanbanDb, resolveDbPath, type Project, type Stats, type Task } from "../../shared/db";

// Shared SQLite database — same file the MCP server uses (see shared/db.ts)
const db = openKanbanDb(resolveDbPath());
const store = createStore(db);

type TodoRPC = {
	bun: RPCSchema<{
		requests: {
			getProjects: { params: {}; response: Project[] };
			createProject: { params: { name: string; description?: string }; response: Project };
			updateProject: {
				params: { id: number; name?: string; description?: string };
				response: Project | null;
			};
			deleteProject: { params: { id: number }; response: { deletedTasks: number } };

			getTasks: { params: { projectId: number }; response: Task[] };
			getTask: { params: { id: number }; response: Task | null };
			createTask: {
				params: {
					projectId: number;
					title: string;
					description?: string;
					status?: Task["status"];
					priority?: Task["priority"];
					assignee?: string;
				};
				response: Task;
			};
			updateTask: {
				params: {
					id: number;
					title?: string;
					description?: string;
					priority?: Task["priority"];
					assignee?: string;
				};
				response: Task | null;
			};
			setTaskStatus: { params: { id: number; status: Task["status"] }; response: Task | null };
			moveTask: {
				params: { id: number; status?: Task["status"]; beforeId?: number | null };
				response: Task | null;
			};
			deleteTask: { params: { id: number }; response: { success: boolean } };

			getStats: { params: { projectId?: number }; response: Stats };
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};

const todoRPC = BrowserView.defineRPC<TodoRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {
			getProjects: () => store.listProjects(),

			createProject: ({ name, description }) => store.createProject({ name, description }),

			updateProject: ({ id, name, description }) =>
				store.updateProject(id, { name, description }),

			deleteProject: ({ id }) => store.deleteProject(id),

			getTasks: ({ projectId }) => store.listTasks({ projectId }),

			getTask: ({ id }) => store.getTask(id),

			createTask: ({ projectId, title, description, status, priority, assignee }) =>
				store.createTask({ projectId, title, description, status, priority, assignee }),

			updateTask: ({ id, title, description, priority, assignee }) =>
				store.updateTask(id, { title, description, priority, assignee }),

			setTaskStatus: ({ id, status }) => store.setTaskStatus(id, status),

			moveTask: ({ id, status, beforeId }) => store.moveTask(id, { status, beforeId }),

			deleteTask: ({ id }) => store.deleteTask(id),

			getStats: ({ projectId }) => store.getStats(projectId),
		},
		messages: {},
	},
});

const mainWindow = new BrowserWindow({
	title: "可拖拽项目看板",
	url: "views://mainview/index.html",
	rpc: todoRPC,
	frame: {
		width: 1200,
		height: 800,
		x: 120,
		y: 80,
	},
});

console.log("Todo Kanban app started!");
console.log(`Database: ${resolveDbPath()}`);
console.log(`Window: ${mainWindow.title}`);
