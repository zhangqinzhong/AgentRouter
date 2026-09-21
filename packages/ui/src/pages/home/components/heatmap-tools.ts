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

export function formatToolCalls(value:number){
 const count=Math.round(Number(value)||0);
 return new Intl.NumberFormat(getCopyLocale()).format(count);
}
