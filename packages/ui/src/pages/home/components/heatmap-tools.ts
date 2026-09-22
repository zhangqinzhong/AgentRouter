import type {LucideIcon} from 'lucide-react';
import {
  AppWindow,
  Bot,
  Clock,
  FileDiff,
  FilePenLine,
  FileSearch,
  FileText,
  Globe,
  HelpCircle,
  Image,
  Keyboard,
  ListTodo,
  MessageSquare,
  Monitor,
  Plug,
  Search,
  Sparkles,
  SquareCode,
  Terminal,
  WandSparkles,
  Wrench
} from 'lucide-react';
import {getCopyLocale} from '@/vendor/tokentracker/lib/copy';

type ToolCopy={en:string;zh:string};

const LABELS:Record<string,ToolCopy>={
 exec_command:{en:'Shell',zh:'执行命令'},
 write_stdin:{en:'Write stdin',zh:'写入输入'},
 update_plan:{en:'Update plan',zh:'更新计划'},
 'node-repl/js':{en:'Node REPL',zh:'Node 交互'},
 'cua-repl/js':{en:'Computer use',zh:'电脑操控'},
 send_message:{en:'Send message',zh:'发送消息'},
 send_input:{en:'Send input',zh:'发送输入'},
 wait_agent:{en:'Wait for agent',zh:'等待子代理'},
 wait:{en:'Wait',zh:'等待'},
 view_image:{en:'View image',zh:'查看图片'},
 list_agents:{en:'List agents',zh:'列出代理'},
 request_user_input:{en:'Ask user',zh:'请求输入'},
 request_user_input_async:{en:'Ask user (async)',zh:'异步请求输入'},
 'computer-use':{en:'Computer use',zh:'电脑使用'},
 'computer-use/set_tool_value':{en:'Set computer-use value',zh:'设置电脑工具'},
 Read:{en:'Read file',zh:'读取文件'},
 Write:{en:'Write file',zh:'写入文件'},
 Edit:{en:'Edit file',zh:'编辑文件'},
 Bash:{en:'Terminal',zh:'终端'},
 Grep:{en:'Search contents',zh:'搜索内容'},
 Glob:{en:'Find files',zh:'匹配文件'},
 WebFetch:{en:'Fetch URL',zh:'抓取网页'},
 WebSearch:{en:'Web search',zh:'网页搜索'},
 Skill:{en:'Skill',zh:'技能'},
 Agent:{en:'Subagent',zh:'子代理'},
 Task:{en:'Task',zh:'任务'},
 apply_patch:{en:'Apply patch',zh:'应用补丁'},
 imagegen:{en:'Generate image',zh:'生成图片'},
 TodoWrite:{en:'Todo list',zh:'待办列表'},
 AskUserQuestion:{en:'Ask user',zh:'询问用户'},
 LSP:{en:'Editor',zh:'编辑器'},
 browser:{en:'Browser',zh:'浏览器'},
 'control-in-app-browser':{en:'In-app browser',zh:'应用内浏览器'},
 'openai-docs':{en:'OpenAI docs',zh:'OpenAI 文档'}
};

const ICONS:Record<string,LucideIcon>={
 exec_command:Terminal,
 Bash:Terminal,
 write_stdin:Keyboard,
 send_input:Keyboard,
 update_plan:ListTodo,
 TodoWrite:ListTodo,
 'node-repl/js':SquareCode,
 'cua-repl/js':AppWindow,
 send_message:MessageSquare,
 wait_agent:Clock,
 wait:Clock,
 view_image:Image,
 imagegen:Sparkles,
 list_agents:Bot,
 Agent:Bot,
 Task:Bot,
 request_user_input:HelpCircle,
 request_user_input_async:HelpCircle,
 AskUserQuestion:HelpCircle,
 'computer-use':Monitor,
 'computer-use/set_tool_value':Monitor,
 Read:FileText,
 Write:FilePenLine,
 Edit:FilePenLine,
 apply_patch:FileDiff,
 Grep:Search,
 Glob:FileSearch,
 WebFetch:Globe,
 WebSearch:Globe,
 browser:Globe,
 'control-in-app-browser':Globe,
 Skill:WandSparkles,
 LSP:SquareCode
};

const ACCENTS:Record<string,string>={
 exec_command:'#f97316',
 Bash:'#f97316',
 write_stdin:'#fb923c',
 send_input:'#fb923c',
 update_plan:'#eab308',
 TodoWrite:'#eab308',
 'node-repl/js':'#6366f1',
 'cua-repl/js':'#8b5cf6',
 send_message:'#0ea5e9',
 wait_agent:'#64748b',
 wait:'#64748b',
 view_image:'#ec4899',
 imagegen:'#d946ef',
 list_agents:'#a855f7',
 Agent:'#a855f7',
 Task:'#a855f7',
 request_user_input:'#f43f5e',
 request_user_input_async:'#f43f5e',
 AskUserQuestion:'#f43f5e',
 'computer-use':'#8b5cf6',
 'computer-use/set_tool_value':'#8b5cf6',
 Read:'#3b82f6',
 Write:'#8b5cf6',
 Edit:'#7c3aed',
 apply_patch:'#c026d3',
 Grep:'#06b6d4',
 Glob:'#0891b2',
 WebFetch:'#0284c7',
 WebSearch:'#2563eb',
 browser:'#0ea5e9',
 'control-in-app-browser':'#0284c7',
 Skill:'#d946ef',
 LSP:'#4f46e5'
};

const ACCENT_FALLBACK=['#38bdf8','#f472b6','#a78bfa','#fbbf24','#2dd4bf','#fb7185','#818cf8','#f97316','#22d3ee','#e879f9'];

function titleCase(part:string){
 const known:Record<string,string>={js:'JS',repl:'REPL',mcp:'MCP',stdin:'Stdin',cwd:'CWD',url:'URL'};
 const lower=part.toLowerCase();
 if(known[lower])return known[lower];
 if(!part)return part;
 return part.charAt(0).toUpperCase()+part.slice(1).replace(/_/g,' ');
}

export function humanizeToolId(id:string){
 if(id.startsWith('mcp__')){
  return id.split('__').slice(1).filter(Boolean).map((part)=>part.replace(/_/g,'-')).map(titleCase).join(' / ');
 }
 return id.split(/[/_-]+/).filter(Boolean).map(titleCase).join(' ');
}

export function toolDisplayName(id:string){
 const mapped=LABELS[id];
 if(mapped)return getCopyLocale().startsWith('zh')?mapped.zh:mapped.en;
 return humanizeToolId(id);
}

const VSCODE_ICONS:Record<string,string>={
 exec_command:'file-type-shell',
 Bash:'file-type-shell',
 write_stdin:'file-type-shell',
 send_input:'file-type-log',
 update_plan:'file-type-todo',
 TodoWrite:'file-type-todo',
 'node-repl/js':'file-type-js',
 'cua-repl/js':'file-type-html',
 send_message:'file-type-log',
 wait_agent:'file-type-log',
 wait:'file-type-log',
 view_image:'file-type-image',
 imagegen:'file-type-image',
 list_agents:'file-type-agents',
 Agent:'file-type-agents',
 Task:'file-type-agents',
 request_user_input:'file-type-text',
 request_user_input_async:'file-type-text',
 AskUserQuestion:'file-type-text',
 'computer-use':'file-type-html',
 'computer-use/set_tool_value':'file-type-html',
 Read:'file-type-text',
 Write:'file-type-text',
 Edit:'file-type-diff',
 apply_patch:'file-type-patch',
 Grep:'file-type-search-result',
 Glob:'default-folder',
 WebFetch:'file-type-html',
 WebSearch:'file-type-search-result',
 browser:'file-type-html',
 'control-in-app-browser':'file-type-html',
 Skill:'folder-type-tools',
 LSP:'file-type-json'
};

export function toolVscodeIcon(id:string):string|undefined{
 if(VSCODE_ICONS[id])return VSCODE_ICONS[id];
 if(id.startsWith('mcp__'))return 'folder-type-tools';
 if(/agent/i.test(id))return 'file-type-agents';
 if(/image|screenshot|photo/i.test(id))return 'file-type-image';
 if(/browser|web|fetch|search/i.test(id))return 'file-type-search-result';
 if(/glob|dir|folder/i.test(id))return 'default-folder';
 if(/read|file/i.test(id))return 'file-type-text';
 if(/bash|shell|exec|command|repl/i.test(id))return 'file-type-shell';
 if(/plan|todo/i.test(id))return 'file-type-todo';
 if(/patch|diff/i.test(id))return 'file-type-patch';
 return undefined;
}

export function toolIcon(id:string):LucideIcon{
 if(ICONS[id])return ICONS[id];
 if(id.startsWith('mcp__'))return Plug;
 if(/agent/i.test(id))return Bot;
 if(/wait|sleep/i.test(id))return Clock;
 if(/image|screenshot|photo/i.test(id))return Image;
 if(/browser|web|fetch|search/i.test(id))return Globe;
 if(/read|file|glob/i.test(id))return FileText;
 if(/bash|shell|exec|command|repl/i.test(id))return Terminal;
 if(/plan|todo/i.test(id))return ListTodo;
 return Wrench;
}

export function toolAccent(id:string){
 if(ACCENTS[id])return ACCENTS[id];
 if(id.startsWith('mcp__'))return '#f59e0b';
 if(/agent/i.test(id))return '#a855f7';
 if(/wait|sleep/i.test(id))return '#64748b';
 if(/image|screenshot|photo/i.test(id))return '#ec4899';
 if(/browser|web|fetch|search/i.test(id))return '#0ea5e9';
 if(/read|file|glob/i.test(id))return '#3b82f6';
 if(/bash|shell|exec|command|repl/i.test(id))return '#f97316';
 if(/plan|todo/i.test(id))return '#eab308';
 let hash=0;
 for(let index=0;index<id.length;index+=1)hash=id.charCodeAt(index)+((hash<<5)-hash);
 return ACCENT_FALLBACK[Math.abs(hash)%ACCENT_FALLBACK.length];
}

export function formatToolCalls(value:number){
 const count=Math.round(Number(value)||0);
 return new Intl.NumberFormat(getCopyLocale()).format(count);
}
