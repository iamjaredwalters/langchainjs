import { ConversationChain } from "langchain/chains";
import { ChatOpenAI } from "langchain/chat_models";
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  SystemMessagePromptTemplate,
  SimpleMessagePromptTemplate,
} from "langchain/prompts";
import { ChatMessageMemory } from "langchain/memory";

export const run = async () => {
  const chat = new ChatOpenAI({ temperature: 0 });

  const chatPrompt = ChatPromptTemplate.fromPromptMessages([
    SystemMessagePromptTemplate.fromTemplate(
      "The following is a friendly conversation between a human and an AI. The AI is talkative and provides lots of specific details from its context. If the AI does not know the answer to a question, it truthfully says it does not know."
    ),
    new SimpleMessagePromptTemplate("history"),
    HumanMessagePromptTemplate.fromTemplate("{input}"),
  ]);

  const chain = new ConversationChain({
    memory: new ChatMessageMemory(),
    prompt: chatPrompt,
    llm: chat,
  });

  const response = await chain.call({
    input: "hi! whats up?",
  });

  console.log(response);
};